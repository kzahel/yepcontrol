package dev.remoteaccess.app

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Bounded work. Neither push receipt nor relay policy establishes endpoint authority. */
class WakeWorker(
    context: Context,
    parameters: WorkerParameters,
) : Worker(context, parameters) {
    override fun doWork(): Result {
        val store = HostStore.get(applicationContext).load()
        if (inputData.getBoolean("registration", false)) return synchronize(store)
        val id = inputData.getString("pairingId") ?: return Result.success()
        val generation = inputData.getString("generation") ?: return Result.success()
        val automatic = !inputData.getBoolean("manual", false)
        val expires = inputData.getLong("expires", 0)
        if (automatic && inputData.getString("requestId")?.matches(Regex("[0-9a-f]{32}")) != true) return Result.success()
        val device = store.device(id) ?: return Result.success()
        if (!store.allowed(id, generation, automatic) || expires <= System.currentTimeMillis() / 1000) return Result.success()
        if (automatic && !WakeSupport.notificationsAllowed(applicationContext)) return Result.success()
        // Synchronize policy before the advanced manual fallback opens a session.
        if (!device.synced && !syncDevice(store, device)) return Result.success()
        val lease = ForegroundAccess.acquireWorker(device)
        if (lease == null) {
            store.record("Session blocked: phone busy", id)
            return Result.success()
        }
        val viewerClosed = CountDownLatch(1)
        val passed = AtomicBoolean(false)
        val control = AtomicBoolean(false)
        val preparedUntil = AtomicLong(0)
        val sessionDeadline = System.currentTimeMillis() + 30 * 60 * 1000
        val current = {
            lease.active.get() &&
                !isStopped &&
                store.allowed(id, generation, automatic) &&
                (!automatic || WakeSupport.notificationsAllowed(applicationContext)) &&
                (
                    if (control.get()) {
                        System.currentTimeMillis() < sessionDeadline
                    } else if (passed.get()) {
                        android.os.SystemClock.elapsedRealtime() < preparedUntil.get()
                    } else {
                        expires > System.currentTimeMillis() / 1000
                    }
                )
        }
        val connection =
            RelayConnection(
                KeystoreIdentity.loadOrCreate("phone-identity-v1"),
                device.authority(),
                { state ->
                    lease.status = state
                    if (current()) {
                        when (state) {
                            "Encrypted session established" -> store.connected(id)
                            "Remote control connected" -> store.record("Remote control started", id)
                            "Encrypted connection passed" -> {
                                preparedUntil.set(android.os.SystemClock.elapsedRealtime() + 30000)
                                passed.set(true)
                                store.record("Connection check completed", id)
                                WakeSupport.preferences(applicationContext).save { putLong("lastWakeExchange", System.currentTimeMillis()) }
                                if (automatic) WakeSupport.notify(applicationContext, "Secure connection verified")
                            }
                            else ->
                                if (state.startsWith("Connection closed") || state.contains("rejected")) {
                                    viewerClosed.countDown()
                                }
                        }
                        store.listeners.forEach { it() }
                    }
                },
                requestId = if (automatic) inputData.getString("requestId") else null,
                accessGeneration = generation,
                current = current,
                features = { PhoneFeatures.report(applicationContext) },
                context = applicationContext,
                onControl = { control.set(true) },
                startSession = {
                    val notification =
                        dev.remoteaccess.app.control.SessionService
                            .notification(applicationContext)
                    val info =
                        if (android.os.Build.VERSION.SDK_INT >= 34) {
                            androidx.work.ForegroundInfo(
                                WakeSupport.WORKER_NOTIFICATION,
                                notification,
                                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                            )
                        } else {
                            androidx.work.ForegroundInfo(WakeSupport.WORKER_NOTIFICATION, notification)
                        }
                    setForegroundAsync(info).get(5, TimeUnit.SECONDS)
                },
            )
        lease.connection = connection
        return try {
            if (!current()) return Result.success()
            store.record("Connection requested", id)
            connection.connect()
            // Keep this exact authenticated lane available for up to 30 seconds after
            // checking. Starting control promotes its existing lease, without a new push.
            while (current() && !viewerClosed.await(100, TimeUnit.MILLISECONDS)) {}
            if (!passed.get() && !control.get()) {
                store.record("Connection failed", id)
            }
            Result.success()
        } finally {
            connection.close(graceful = passed.get())
            HostSessions.release(lease)
            store.record("Connection ended", id)
        }
    }

    private fun synchronize(store: HostStore): Result {
        var failed = false
        for (device in store.snapshot.devices) {
            if (isStopped) break
            // Keep unsupported grants visible for local removal, but never contact their service.
            if (!device.originAllowed) {
                if (device.revoked) store.removed(device.id)
                continue
            }
            if (device.revoked) {
                try {
                    val grant = device.authority()
                    val identity = KeystoreIdentity.loadOrCreate("phone-identity-v1")
                    val signature = identity.sign(fields("ara/pair/revoke/v1", grant.getString("origin"), device.id))
                    request(grant.getString("origin"), device.id, "revoke", org.json.JSONObject().put("signature", encoded(signature)))
                    store.removed(device.id)
                } catch (_: Exception) {
                    failed = true
                }
            } else if (!syncDevice(store, device)) {
                failed = true
            }
        }
        WakeSupport.preferences(applicationContext).save {
            putString(
                "wakeState",
                if (failed) "Some device settings could not be synchronized. Retry in Settings." else "Device settings synchronized",
            )
        }
        store.listeners.forEach { it() }
        return Result.success()
    }

    private fun syncDevice(
        store: HostStore,
        device: Device,
    ): Boolean {
        val preferences = WakeSupport.preferences(applicationContext)
        val enabled = store.allowed(device.id, device.generation)
        val push = enabled && store.snapshot.settings.automatic && WakeSupport.notificationsAllowed(applicationContext)
        val fid = if (push) preferences.getString("fid", null) else null
        val expected = if (fid != null) "Remote wake ready" else "Remote wake disabled"
        val done = CountDownLatch(1)
        val passed = AtomicBoolean(false)
        val current = { !isStopped && store.device(device.id)?.let { !it.revoked && it.generation == device.generation } == true }
        val connection =
            RelayConnection(
                KeystoreIdentity.loadOrCreate("phone-identity-v1"),
                device.authority(),
                { state ->
                    if (state == expected) {
                        passed.set(true)
                        done.countDown()
                    } else if (state.startsWith("Connection closed") || state.contains("rejected")) {
                        done.countDown()
                    }
                },
                fid = fid,
                registrationOnly = true,
                removePush = fid == null,
                accessGeneration = device.generation,
                accessEnabled = enabled,
                current = current,
            )
        return try {
            connection.connect()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (current() && System.nanoTime() < deadline && !done.await(100, TimeUnit.MILLISECONDS)) {}
            if (passed.get() && current()) {
                store.synced(device.id, device.generation, wakeReady = fid != null)
            } else {
                store.record("Wake setup failed", device.id)
            }
            passed.get() && current()
        } catch (_: Exception) {
            store.record("Wake setup failed", device.id)
            false
        } finally {
            connection.close(graceful = passed.get())
        }
    }
}

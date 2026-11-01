package dev.remoteaccess.app

import android.content.Context
import androidx.work.Data
import androidx.work.WorkManager
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Process-owned sessions, separate from activity navigation. Policy is checked again per record. */
internal object HostSessions {
    class Lease(
        val deviceId: String,
        val generation: String,
    ) {
        val active = AtomicBoolean(true)

        @Volatile var status = "Connecting"

        @Volatile var connection: RelayConnection? = null

        fun close() {
            active.set(false)
            connection?.close()
        }
    }

    val current = AtomicReference<Lease?>(null)

    fun acquire(device: Device): Lease? {
        val lease = Lease(device.id, device.generation)
        return if (current.compareAndSet(null, lease)) lease else null
    }

    fun release(lease: Lease) {
        lease.active.set(false)
        current.compareAndSet(lease, null)
    }

    fun stop(id: String? = null) {
        val lease = current.get() ?: return
        if (id == null || lease.deviceId == id) {
            if (current.compareAndSet(lease, null)) lease.close()
        }
    }
}

internal object HostRuntime {
    val io = Executors.newSingleThreadExecutor()
    val network = Executors.newFixedThreadPool(2)

    fun change(
        context: Context,
        work: (HostStore) -> Unit,
        finished: (Boolean) -> Unit = {},
    ) {
        val app = context.applicationContext
        io.execute {
            try {
                val store = HostStore.get(app).load()
                work(store)
                if (!store.snapshot.settings.armed) {
                    dev.remoteaccess.app.advanced.AdvancedControl
                        .stop(app)
                }
                HostSessions.current.get()?.let {
                    if (!store.allowed(it.deviceId, it.generation)) {
                        HostSessions.stop()
                        store.record("Access stopped on phone", it.deviceId)
                    }
                }
                store.snapshot.devices.forEach { device ->
                    if (!store.allowed(device.id, device.generation)) {
                        WorkManager.getInstance(app).cancelUniqueWork("remote-wake-${device.id}")
                    }
                }
                WakeSupport.register(app)
                WakeSupport.enqueue(app, Data.EMPTY, registration = true)
                finished(true)
            } catch (_: Exception) {
                finished(false)
            }
        }
    }

    fun connect(
        context: Context,
        id: String,
    ) {
        io.execute {
            val store = HostStore.get(context).load()
            val device = store.device(id) ?: return@execute
            if (!store.allowed(id, device.generation)) return@execute
            WakeSupport.enqueue(
                context,
                Data
                    .Builder()
                    .putString("pairingId", id)
                    .putString("generation", device.generation)
                    .putBoolean("manual", true)
                    .putLong("expires", System.currentTimeMillis() / 1000 + 65)
                    .build(),
            )
        }
    }

    fun disconnect(
        context: Context,
        id: String,
    ) {
        io.execute {
            val store = HostStore.get(context).load()
            HostSessions.stop(id)
            ForegroundAccess.disconnect(id)
            WorkManager.getInstance(context).cancelUniqueWork("remote-wake-$id")
            store.record("Disconnected on phone", id)
        }
    }
}

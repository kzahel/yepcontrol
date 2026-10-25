package dev.remoteaccess.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Visible-app reachability needs no notification, accessibility or capture permission. */
internal object ForegroundAccess {
    private class Entry(
        val device: Device,
    ) {
        val active = AtomicBoolean(true)
        lateinit var connection: RelayConnection

        @Volatile var ready = false

        @Volatile var lease: HostSessions.Lease? = null

        @Volatile var expires = Long.MAX_VALUE

        @Volatile var passed = false

        @Volatile var control = false
    }

    private val entries = ConcurrentHashMap<String, Entry>()
    private val owners = mutableSetOf<Any>()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var store: HostStore
    private lateinit var app: android.app.Application
    private val retryAfter = mutableMapOf<String, Long>()

    @Volatile private var visible = false
    private val retry = Runnable { HostRuntime.io.execute { reconcile() } }
    private val listener: () -> Unit = { HostRuntime.io.execute { reconcile() } }

    fun start(
        context: Context,
        owner: Any,
    ) {
        val application = context.applicationContext as android.app.Application
        HostRuntime.io.execute {
            synchronized(this) {
                app = application
                store = HostStore.get(app).load()
                store.listeners.add(listener)
                owners.add(owner)
                visible = true
                reconcile()
            }
        }
    }

    fun stop(owner: Any) {
        HostRuntime.io.execute {
            synchronized(this) {
                owners.remove(owner)
                visible = owners.isNotEmpty()
                if (!visible) {
                    handler.removeCallbacks(retry)
                    entries.values
                        .toList()
                        .filter { !it.control && !it.passed }
                        .forEach { end(it) }
                    retryAfter.clear()
                }
            }
        }
    }

    fun listening(id: String): Boolean = entries[id]?.let { it.active.get() && it.ready } == true

    @Synchronized
    fun acquireWorker(device: Device): HostSessions.Lease? {
        val entry = entries[device.id]
        if (entry?.lease != null) return null
        if (entry != null) end(entry)
        return HostSessions.acquire(device)
    }

    @Synchronized
    fun disconnect(id: String) {
        entries[id]?.let { end(it) }
        schedule(500)
    }

    private fun valid(entry: Entry): Boolean =
        (visible || entry.control || entry.passed) &&
            entry.active.get() &&
            store.allowed(entry.device.id, entry.device.generation) &&
            (entry.lease?.active?.get() != false) &&
            System.currentTimeMillis() < entry.expires

    private fun admit(entry: Entry): Boolean {
        if (!valid(entry)) return false
        val lease = HostSessions.acquire(entry.device) ?: return false
        entry.lease = lease
        lease.connection = entry.connection
        if (!valid(entry)) {
            HostSessions.release(lease)
            return false
        }
        entry.expires = System.currentTimeMillis() + 65000
        store.record("Connection requested", entry.device.id)
        handler.postDelayed({
            HostRuntime.io.execute {
                synchronized(this) {
                    if (entries[entry.device.id] === entry && !entry.control) {
                        end(entry)
                        reconcile()
                    }
                }
            }
        }, 65000)
        return true
    }

    @Synchronized
    private fun reconcile() {
        entries.values
            .toList()
            .filter { !valid(it) }
            .forEach { end(it) }
        if (!visible) return
        var delay = Long.MAX_VALUE
        for (device in store.snapshot.devices) {
            if (!device.synced || !store.allowed(device.id, device.generation) || entries.containsKey(device.id)) continue
            if (HostSessions.current.get()?.deviceId == device.id) continue
            val remaining = (retryAfter[device.id] ?: 0) - System.currentTimeMillis()
            if (remaining > 0) {
                delay = minOf(delay, remaining)
                continue
            }
            val entry = Entry(device)
            entries[device.id] = entry
            entry.connection =
                RelayConnection(
                    KeystoreIdentity.loadOrCreate("phone-identity-v1"),
                    device.authority(),
                    { state -> HostRuntime.io.execute { report(entry, state) } },
                    accessGeneration = device.generation,
                    current = { valid(entry) },
                    admit = { admit(entry) },
                    features = { PhoneFeatures.report(app) },
                    context = app,
                    onControl = {
                        entry.control = true
                        entry.expires = System.currentTimeMillis() + 30 * 60 * 1000
                        handler.postDelayed({ entry.connection.close() }, 30 * 60 * 1000)
                    },
                )
            entry.connection.connect()
        }
        if (delay != Long.MAX_VALUE) schedule(delay)
    }

    @Synchronized
    private fun report(
        entry: Entry,
        state: String,
    ) {
        if (entries[entry.device.id] !== entry || !entry.active.get()) return
        entry.lease?.status = state
        when (state) {
            "Waiting for your device" -> entry.ready = true
            "Encrypted session established" -> store.connected(entry.device.id)
            "Remote control connected" -> store.record("Remote control started", entry.device.id)
            "Encrypted connection passed" -> {
                entry.passed = true
                entry.expires = System.currentTimeMillis() + 30000
                store.record("Connection check completed", entry.device.id)
                handler.postDelayed({
                    HostRuntime.io.execute {
                        synchronized(this) {
                            if (entries[entry.device.id] === entry && !entry.control) {
                                end(entry, graceful = true)
                                reconcile()
                            }
                        }
                    }
                }, 30000)
            }
            else ->
                if (state.startsWith("Connection closed") || state.contains("rejected")) {
                    end(entry, reconnectDelay = if (entry.passed) 500 else 5000)
                    schedule(if (entry.passed) 500 else 5000)
                }
        }
        store.listeners.forEach { it() }
    }

    private fun end(
        entry: Entry,
        graceful: Boolean = false,
        reconnectDelay: Long = 500,
    ) {
        if (!entry.active.compareAndSet(true, false)) return
        entries.remove(entry.device.id, entry)
        retryAfter[entry.device.id] = System.currentTimeMillis() + reconnectDelay
        entry.connection.close(graceful)
        entry.lease?.let {
            HostSessions.release(it)
            store.record("Connection ended", entry.device.id)
        }
    }

    private fun schedule(delay: Long) {
        if (visible) {
            handler.removeCallbacks(retry)
            handler.postDelayed(retry, delay)
        }
    }
}

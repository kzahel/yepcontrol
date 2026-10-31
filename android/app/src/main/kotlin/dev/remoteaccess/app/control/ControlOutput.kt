package dev.remoteaccess.app.control

import dev.remoteaccess.protocol.MediaRecord
import dev.remoteaccess.protocol.RecordOutbox
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One drain per owner. Direct lanes use their RTC worker; relay owners use a dedicated writer.
 * The send callback borrows plaintext only until it returns; transports must copy/seal synchronously.
 */
internal class ControlOutput(
    private val current: () -> Boolean,
    private val send: (ByteArray) -> Unit,
    private val failed: () -> Unit,
    scheduler: ((() -> Unit) -> Boolean)? = null,
) {
    private val owned = if (scheduler == null) Executors.newSingleThreadExecutor() else null
    private val schedule = scheduler ?: { work: () -> Unit -> runCatching { checkNotNull(owned).execute { work() } }.isSuccess }
    private val outbox = RecordOutbox()
    private val draining = AtomicBoolean(false)

    fun control(bytes: ByteArray) {
        if (!current() || !outbox.control(bytes) || !drain()) {
            bytes.fill(0)
            failed()
        }
    }

    fun media(record: MediaRecord): Boolean = current() && outbox.media(record) && drain()

    private fun drain(): Boolean {
        if (!draining.compareAndSet(false, true)) return true
        if (!schedule {
                try {
                    while (current()) {
                        val bytes = outbox.poll() ?: break
                        try {
                            if (current()) send(bytes)
                        } finally {
                            bytes.fill(0)
                        }
                    }
                } catch (_: Exception) {
                    failed()
                } finally {
                    draining.set(false)
                    if (current() && outbox.pending()) drain()
                }
            }
        ) {
            draining.set(false)
            return false
        }
        return true
    }

    fun close() {
        outbox.close()
        owned?.shutdownNow()
    }
}

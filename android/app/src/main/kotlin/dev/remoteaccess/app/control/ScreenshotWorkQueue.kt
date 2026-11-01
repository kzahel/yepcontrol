package dev.remoteaccess.app.control

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/** Own each delivered screenshot buffer, including callbacks arriving after service destruction. */
internal class ScreenshotWorkQueue(
    private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
) : AutoCloseable {
    fun submit(
        buffer: AutoCloseable,
        rejected: () -> Unit,
        process: () -> Unit,
    ) {
        try {
            executor.execute {
                try {
                    process()
                } finally {
                    buffer.close()
                }
            }
        } catch (_: RejectedExecutionException) {
            buffer.close()
            rejected()
        }
    }

    override fun close() {
        // At most one capture is outstanding. Drain accepted work so queued buffers are released.
        executor.shutdown()
    }
}

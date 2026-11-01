package dev.remoteaccess.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remoteaccess.app.control.ScreenshotWorkQueue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class ScreenshotWorkQueueTest {
    private class Buffer(
        val afterClose: () -> Unit = {},
    ) : AutoCloseable {
        val closes = AtomicInteger()

        override fun close() {
            closes.incrementAndGet()
            afterClose()
        }
    }

    @Test fun acceptedScreenshotReleasesItsBuffer() {
        val executor = Executors.newSingleThreadExecutor()
        val queue = ScreenshotWorkQueue(executor)
        val buffer = Buffer()
        val processed = AtomicBoolean()
        try {
            queue.submit(buffer, rejected = { error("Unexpected rejection") }) { processed.set(true) }
        } finally {
            queue.close()
        }
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        assertTrue(processed.get())
        assertEquals(1, buffer.closes.get())
    }

    @Test fun lateCallbackClosesItsBufferAndRefusesWithoutProcessing() {
        val executor = Executors.newSingleThreadExecutor()
        val queue = ScreenshotWorkQueue(executor)
        val buffer = Buffer()
        val rejected = AtomicInteger()
        val processed = AtomicBoolean()
        val caller = Thread.currentThread()
        queue.close()
        queue.submit(buffer, rejected = {
            assertEquals(caller, Thread.currentThread())
            assertEquals(1, buffer.closes.get())
            rejected.incrementAndGet()
        }) { processed.set(true) }
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        assertEquals(1, rejected.get())
        assertFalse(processed.get())
        assertEquals(1, buffer.closes.get())
    }

    @Test fun destructionDrainsAlreadyAcceptedBuffers() {
        val executor = Executors.newSingleThreadExecutor()
        val queue = ScreenshotWorkQueue(executor)
        val closing = CountDownLatch(1)
        val release = CountDownLatch(1)
        val timedOut = AtomicBoolean()
        val first =
            Buffer {
                closing.countDown()
                if (!release.await(5, TimeUnit.SECONDS)) timedOut.set(true)
            }
        val second = Buffer()
        val processedSecond = AtomicBoolean()
        try {
            queue.submit(first, rejected = { error("Unexpected rejection") }) {}
            assertTrue(closing.await(5, TimeUnit.SECONDS))
            // The prior callback has finished processing but still owns its buffer.
            queue.submit(second, rejected = { error("Unexpected rejection") }) { processedSecond.set(true) }
            queue.close()
        } finally {
            release.countDown()
            queue.close()
        }
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        assertFalse(timedOut.get())
        assertTrue(processedSecond.get())
        assertEquals(1, first.closes.get())
        assertEquals(1, second.closes.get())
    }
}

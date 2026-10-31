package dev.remoteaccess.protocol

import java.nio.ByteBuffer
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RecordOutboxTest {
    private fun frame(
        stream: Int,
        seq: Long = 1,
    ) = MediaRecord(3, stream, seq, 1, 16000, 1, false, byteArrayOf(0, 1))

    @Test fun controlAndTerminalTakePriorityAndTerminalPurgesOnlyItsStream() {
        val box = RecordOutbox()
        assertTrue(box.media(frame(1)))
        assertTrue(box.media(frame(2)))
        val reply = byteArrayOf(1, 2, 3)
        assertTrue(box.control(reply))
        assertContentEquals(reply, box.poll())
        val terminal = MediaRecord(4, 1, 2, 1, data = byteArrayOf(2, 7))
        assertTrue(box.media(terminal))
        assertContentEquals(terminal.encode(), box.poll())
        assertEquals(2, ByteBuffer.wrap(checkNotNull(box.poll())).getInt(8))
        assertNull(box.poll())
    }

    @Test fun aBlockedMediaReceiverCannotConsumeReservedControlCapacity() {
        val box = RecordOutbox()
        repeat(12) { assertTrue(box.media(frame(1, it + 1L))) }
        assertFalse(box.media(frame(1, 13)))
        val stop = byteArrayOf(7)
        assertTrue(box.control(stop))
        assertContentEquals(stop, box.poll())
        box.close()
        assertFalse(box.pending())
        assertNull(box.poll())
        assertFalse(box.media(frame(1)))
        assertFalse(box.control(byteArrayOf(1)))
    }
}

package dev.remoteaccess.protocol

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertFails

class YuvPlaneTest {
    @Test fun rectangularRotationAndInterleavedPadding() {
        // Source rows 1 2 / 3 4 / 5 6, with interleaved chroma and row padding.
        val source = byteArrayOf(1, 99, 2, 88, 88, 3, 99, 4, 88, 88, 5, 99, 6)
        val expected =
            mapOf(
                0 to listOf(1, 2, 3, 4, 5, 6),
                90 to listOf(5, 3, 1, 6, 4, 2),
                180 to listOf(6, 5, 4, 3, 2, 1),
                270 to listOf(2, 4, 6, 1, 3, 5),
            )
        for ((degrees, values) in expected) {
            val width = if (degrees % 180 == 0) 2 else 3
            val height = 6 / width
            val stride = width * 2 + 1
            val target = ByteArray(height * stride) { 77 }
            YuvPlane.rotate(source, 5, 2, target, stride, 2, 2, 3, degrees)
            val witness = ByteArray(target.size) { 77 }
            values.forEachIndexed { index, n -> witness[index / width * stride + index % width * 2] = n.toByte() }
            assertContentEquals(witness, target)
        }
    }

    @Test fun boundsAreCheckedBeforeWriting() {
        val target = byteArrayOf(77, 77, 77, 77)
        assertFails { YuvPlane.rotate(byteArrayOf(1, 2), 2, 1, target, 2, 1, 2, 2, 0) }
        assertContentEquals(byteArrayOf(77, 77, 77, 77), target)
        assertFails { YuvPlane.rotate(byteArrayOf(1, 2, 3, 4), 2, 1, target, 2, 1, 2, 2, 45) }
    }
}

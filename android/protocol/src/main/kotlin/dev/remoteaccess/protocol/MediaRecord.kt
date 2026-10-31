package dev.remoteaccess.protocol

import java.nio.ByteBuffer

/** ARM1 packets remain inside the existing authenticated record transport. */
data class MediaRecord(
    val kind: Int,
    val stream: Int,
    val sequence: Long,
    val timestamp: Long,
    val width: Int = 0,
    val height: Int = 0,
    val key: Boolean = false,
    val data: ByteArray,
) {
    fun encode(): ByteArray {
        require(kind in 1..4 && stream > 0 && sequence in 1..0xffffffffL && timestamp in 0..9007199254740991L)
        require(data.size in 2..(1048576 - 32))
        require(!key || kind == 2)
        when (kind) {
            1, 2 -> {
                require(width in 1..4096 && height in 1..4096 && width.toLong() * height <= 16777216)
                if (kind == 1) require(data[0] == 255.toByte() && data[1] == 216.toByte())
                if (kind == 2) {
                    require(data.size >= 5 && data[0] == 0.toByte() && data[1] == 0.toByte())
                    require(data[2] == 1.toByte() || (data[2] == 0.toByte() && data[3] == 1.toByte()))
                }
            }
            3 -> require(width == 16000 && height == 1 && data.size <= 6400 && data.size % 2 == 0)
            4 -> {
                require(width == 0 && height == 0 && data.size == 2)
                val phase = data[0].toInt()
                val reason = data[1].toInt()
                require(phase in 1..3 && reason in 0..8)
                require(phase != 1 || reason == 0)
                require(phase != 3 || reason != 0)
            }
        }
        return ByteBuffer
            .allocate(32 + data.size)
            .putInt(0x41524d31)
            .put(kind.toByte())
            .put(if (key) 1.toByte() else 0.toByte())
            .putShort(0)
            .putInt(stream)
            .putInt(sequence.toInt())
            .putLong(timestamp)
            .putInt(width)
            .putInt(height)
            .put(data)
            .array()
    }

    companion object {
        const val LEASE_MS = 20000L
        const val START_MS = 10000L
    }
}

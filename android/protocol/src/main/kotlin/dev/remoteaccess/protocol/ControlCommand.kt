package dev.remoteaccess.protocol

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Strict binary application boundary, independent of Android and transport. */
data class ControlCommand(
    val id: Long,
    val op: Int,
    val values: List<Int> = emptyList(),
    val text: String = "",
    val touch: TouchBatch? = null,
    val observation: String = "",
) {
    companion object {
        fun decode(bytes: ByteArray): ControlCommand {
            require(bytes.size in 12..32784)
            val input = ByteBuffer.wrap(bytes)
            require(input.int == 0x41524331)
            val op = input.get().toInt() and 255
            require(input.get() == 0.toByte() && input.get() == 0.toByte() && input.get() == 0.toByte())
            val id = input.int.toLong() and 0xffffffffL
            require(id > 0)
            val values = mutableListOf<Int>()
            var text = ""
            var touch: TouchBatch? = null
            var observation = ""
            when (op) {
                1, 2, 3, 9, 10, 12, 14, 15, 17, 18, 20 -> require(!input.hasRemaining())
                4, 5 -> {
                    val count = if (op == 4) 3 else 6
                    require(input.remaining() == count * 4)
                    repeat(count) { values.add(input.int.also { require(it >= 0) }) }
                    require(values[0] > 0)
                    if (op == 5) require(values[5] in 40..2000)
                }
                16 -> {
                    require(input.remaining() == 1)
                    values.add(input.get().toInt().also { require(it in 0..3) })
                }
                6 -> {
                    require(input.remaining() == 1)
                    values.add(input.get().toInt().also { require(it in 1..3) })
                }
                7, 8, 13, 19 -> {
                    require(
                        input.remaining() <=
                            when (op) {
                                7 -> 4096
                                13 -> 16
                                19 -> 32768
                                else -> 256
                            },
                    )
                    text =
                        Charsets.UTF_8
                            .newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(input)
                            .toString()
                    if (op == 19) require(text.startsWith("v=0\r\n"))
                    if (op == 13) require(text.matches(Regex("[0-9]{4,16}")))
                    if (op == 8) require(text.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")))
                }
                21, 22, 23 -> {
                    require(input.remaining() >= 20)
                    val token = ByteArray(16).also { input.get(it) }
                    observation = token.joinToString("") { "%02x".format(it.toInt() and 255) }
                    values.add(input.int.also { require(it in 0..127) })
                    when (op) {
                        21 -> require(!input.hasRemaining())
                        22 -> {
                            require(input.remaining() == 1)
                            values.add(input.get().toInt().also { require(it in 1..2) })
                        }
                        23 -> {
                            require(input.remaining() <= 4096)
                            text =
                                Charsets.UTF_8
                                    .newDecoder()
                                    .onMalformedInput(CodingErrorAction.REPORT)
                                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                                    .decode(input)
                                    .toString()
                        }
                    }
                }
                11 -> touch = TouchBatch.decode(input)
                else -> error("Unknown command")
            }
            return ControlCommand(id, op, values, text, touch, observation)
        }

        fun reply(
            id: Long,
            kind: Int,
            payload: ByteArray,
        ): ByteArray {
            require(id in 1..0xffffffffL && kind in 1..7 && payload.size <= 1048564)
            return ByteBuffer
                .allocate(12 + payload.size)
                .putInt(0x41525031)
                .put(kind.toByte())
                .put(byteArrayOf(0, 0, 0))
                .putInt(id.toInt())
                .put(payload)
                .array()
        }
    }
}

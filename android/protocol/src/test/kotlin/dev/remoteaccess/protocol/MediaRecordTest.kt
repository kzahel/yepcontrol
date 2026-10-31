package dev.remoteaccess.protocol

import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class MediaRecordTest {
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun sharedWireVectors() {
        val vectors = JSONObject(File(System.getProperty("vectors")).resolveSibling("media-v1.json").readText())
        val packets = vectors.getJSONArray("packets")
        for (i in 0 until packets.length()) {
            val v = packets.getJSONObject(i)
            val record =
                MediaRecord(
                    i + 1,
                    v.getInt("stream"),
                    v.getLong("sequence"),
                    v.getLong("timestamp"),
                    v.getInt("width"),
                    v.getInt("height"),
                    v.getBoolean("key"),
                    bytes(v.getString("dataHex")),
                )
            assertEquals(v.getString("hex"), record.encode().joinToString("") { "%02x".format(it.toInt() and 255) })
        }
        val commands = vectors.getJSONArray("commands")
        for (i in 0 until commands.length()) {
            val v = commands.getJSONObject(i)
            val parsed = ControlCommand.decode(bytes(v.getString("hex")))
            val command = v.getJSONObject("command")
            assertEquals(
                listOf("cameraStart", "microphoneStart", "mediaStop", "mediaRenew").indexOf(command.getString("op")) + 24,
                parsed.op,
            )
            assertEquals(v.getLong("id"), parsed.id)
            val expected = mutableListOf(command.getInt("stream"))
            if (parsed.op == 24) {
                expected.add(if (command.getString("facing") == "rear") 1 else 2)
                expected.add(if (command.getString("format") == "jpeg") 1 else 2)
                expected.add(command.getInt("fps"))
            }
            assertEquals(expected, parsed.values)
        }
    }

    @Test fun imageAndRecordBounds() {
        val jpeg = MediaRecord(1, 1, 1, 0, 1, 1, false, byteArrayOf(255.toByte(), 216.toByte()))
        assertEquals(34, jpeg.encode().size)
        assertEquals(34, jpeg.copy(width = 4096, height = 4096).encode().size)
        for ((width, height) in listOf(0 to 240, 320 to 0, 4097 to 240, 320 to 4097)) {
            assertFails { jpeg.copy(width = width, height = height).encode() }
        }
        val atLimit = ByteArray(1048576 - 32).also { jpeg.data.copyInto(it) }
        assertEquals(1048576, jpeg.copy(data = atLimit).encode().size)
        assertFails { jpeg.copy(data = atLimit.copyOf(atLimit.size + 1)).encode() }
    }

    @Test fun rejectsMalformedMediaAndCommands() {
        val record = MediaRecord(3, 1, 1, 1, 16000, 1, false, byteArrayOf(0, 0))
        for (bad in listOf(
            record.copy(stream = 0),
            record.copy(sequence = 0),
            record.copy(timestamp = 9007199254740992L),
            record.copy(key = true),
            record.copy(width = 48000),
            record.copy(data = byteArrayOf(0)),
        )) {
            assertFails { bad.encode() }
        }
        val command = bytes("4152433118000000000000010000000701020f")
        for (length in 12 until command.size) assertFails { ControlCommand.decode(command.copyOf(length)) }
        for (index in listOf(12, 16, 17, 18)) assertFails { ControlCommand.decode(command.copyOf().also { it[index] = 255.toByte() }) }
        for ((format, fps) in listOf(1 to 0, 1 to 6, 2 to 0, 2 to 31)) {
            assertFails {
                ControlCommand.decode(
                    command.copyOf().also {
                        it[17] = format.toByte()
                        it[18] = fps.toByte()
                    },
                )
            }
        }
        assertFails { ControlCommand.decode(command + byteArrayOf(0)) }
        assertFails { ControlCommand.decode(bytes("41524331190000000000000100000000")) }
    }
}

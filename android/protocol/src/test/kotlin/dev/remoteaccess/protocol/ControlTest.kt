package dev.remoteaccess.protocol

import org.json.JSONArray
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class ControlTest {
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun sharedCommandVectors() {
        val file = File(System.getProperty("vectors")).resolveSibling("control-v1.json")
        val vectors = JSONArray(file.readText())
        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val parsed = ControlCommand.decode(bytes(vector.getString("hex")))
            val expected = vector.getJSONObject("command")
            assertEquals(vector.getLong("id"), parsed.id)
            when (expected.getString("op")) {
                "tap" -> assertEquals(listOf(3, 120, 240), parsed.values)
                "swipe" -> assertEquals(listOf(3, 120, 240, 400, 500, 300), parsed.values)
                "navigation" -> assertEquals(listOf(2), parsed.values)
                "text" -> assertEquals(expected.getString("text"), parsed.text)
                "launch" -> assertEquals(expected.getString("packageName"), parsed.text)
                "snapshot" -> assertEquals(20, parsed.op)
                "nodeClick", "nodeScroll", "nodeText" -> {
                    assertEquals(expected.getString("observation"), parsed.observation)
                    assertEquals(7, parsed.values[0])
                    if (parsed.op == 22) assertEquals(2, parsed.values[1])
                    if (parsed.op == 23) assertEquals(expected.getString("text"), parsed.text)
                }
                "touch" -> {
                    val batch = requireNotNull(parsed.touch)
                    assertEquals(42, batch.gesture)
                    assertEquals(
                        TouchPoint(120.25f, 240.5f),
                        batch.contacts
                            .single()
                            .path
                            .single(),
                    )
                }
            }
        }
    }

    @Test fun malformedCommandsAreRejectedBeforeExecution() {
        val good = bytes("4152433104000000000000020000000300000078000000f0")
        for (length in 0 until good.size) assertFails { ControlCommand.decode(good.copyOf(length)) }
        for (index in listOf(0, 4, 5, 12, 16, 20)) {
            val bad = good.copyOf()
            bad[index] = 255.toByte()
            assertFails { ControlCommand.decode(bad) }
        }
        assertFails { ControlCommand.decode(good + byteArrayOf(0)) }
        assertFails { ControlCommand.decode(bytes("415243310700000000000001ff")) }
        assertFails { ControlCommand.decode(bytes("41524331060000000000000100")) }
        assertFails { ControlCommand.decode(bytes("415243310800000000000001")) }
    }

    @Test fun unlockOnlyAdmitsBoundedAsciiDigits() {
        val header = "415243310d00000000000008"
        assertEquals("314159", ControlCommand.decode(bytes(header + "333134313539")).text)
        for (pin in listOf("", "123", "1".repeat(17), "1234\n", "１２３４", "123a")) {
            assertFails { ControlCommand.decode(bytes(header) + pin.toByteArray()) }
        }
    }

    @Test fun touchRejectsMissingContactsInvalidFlagsAndNonfiniteSamples() {
        val good = bytes("415243310b00000000000007000000030000002a0000000000280100000000000101000042f0800043708000")
        assertEquals(
            1,
            ControlCommand
                .decode(good)
                .touch
                ?.contacts
                ?.size,
        )
        for (length in 12 until good.size) assertFails { ControlCommand.decode(good.copyOf(length)) }
        for (index in listOf(24, 26, 27, 32, 33, 34, 36, 40)) {
            val bad = good.copyOf()
            bad[index] = 255.toByte()
            assertFails { ControlCommand.decode(bad) }
        }
    }

    @Test fun nodeActionsRejectMalformedTargetsBeforeExecution() {
        val click = bytes("41524331150000000000001500112233445566778899aabbccddeeff00000007")
        for (length in 12 until click.size) assertFails { ControlCommand.decode(click.copyOf(length)) }
        assertFails { ControlCommand.decode(click + byteArrayOf(0)) }
        assertFails { ControlCommand.decode(click.copyOf().also { it[it.lastIndex] = 128.toByte() }) }
        val scroll = click.copyOf().also { it[4] = 22 }
        for (direction in listOf(0, 3, 255)) assertFails { ControlCommand.decode(scroll + byteArrayOf(direction.toByte())) }
        val text = click.copyOf().also { it[4] = 23 }
        assertFails { ControlCommand.decode(text + byteArrayOf(255.toByte())) }
        assertFails { ControlCommand.decode(text + ByteArray(4097)) }
    }
}

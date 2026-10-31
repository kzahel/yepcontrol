package dev.remoteaccess.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PendingResourceTest {
    @Test fun cancellationBeforeLateOpenClosesWithoutStartingAndWaitsForClose() {
        val handle = Any()
        var closes = 0
        var completions = 0
        val gate =
            PendingResource<Any> {
                assertTrue(it === handle)
                closes++
            }
        gate.starting()
        gate.release { completions++ }
        assertEquals(0, closes)
        assertEquals(0, completions)
        assertFalse(gate.arrived(handle, true), "A late open must not begin capture")
        assertEquals(1, closes)
        assertEquals(0, completions, "Stop cannot report release before native onClosed")
        gate.closed(handle)
        gate.closed(handle)
        assertEquals(1, completions)
    }

    @Test fun cancellationBeforeReleaseTaskAndSynchronousOpenFailure() {
        val handle = Any()
        var closes = 0
        var completions = 0
        val gate = PendingResource<Any> { closes++ }
        gate.starting()
        assertFalse(gate.arrived(handle, false)) // Main already canceled; worker release task is later.
        gate.release { completions++ }
        assertEquals(1, closes)
        assertEquals(0, completions)
        gate.closed(handle)
        assertEquals(1, completions)
        val failed = PendingResource<Any> { error("No resource exists") }
        failed.starting()
        failed.failed()
        failed.release { completions++ }
        assertEquals(2, completions)
    }
}

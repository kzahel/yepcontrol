package dev.remoteaccess.protocol

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SemanticGuardTest {
    @Test fun disconnectDuringBlockedResolutionPreventsDispatch() {
        val resolving = CountDownLatch(1)
        val release = CountDownLatch(1)
        val allowed = AtomicBoolean(true)
        var dispatched = false
        var result = -1
        val worker =
            thread {
                result =
                    SemanticGuard.perform(resolve = {
                        resolving.countDown()
                        check(release.await(3, TimeUnit.SECONDS))
                        "resolved target"
                    }, allowed = { allowed.get() }, action = {
                        dispatched = true
                        0
                    })
            }
        assertTrue(resolving.await(3, TimeUnit.SECONDS))
        allowed.set(false)
        release.countDown()
        worker.join(3000)
        assertEquals(8, result)
        assertEquals(false, dispatched)
    }

    @Test fun fingerprintSeesSuffixChangesAndFieldBoundaries() {
        val prefix = "a".repeat(256)
        assertNotEquals(SemanticGuard.fingerprint(listOf(prefix + "old")), SemanticGuard.fingerprint(listOf(prefix + "new")))
        assertNotEquals(SemanticGuard.fingerprint(listOf("ab", "c")), SemanticGuard.fingerprint(listOf("a", "bc")))
        assertNull(SemanticGuard.fingerprint(listOf("x".repeat(4097))))
    }
}

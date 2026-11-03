package dev.remoteaccess.app

import android.app.UiAutomation
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import dev.remoteaccess.app.control.SemanticAccess
import dev.remoteaccess.protocol.ControlCommand
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class AccessibilityQueryTest {
    @Suppress("DEPRECATION")
    @Test
    fun completeSearchAndFreshReferencesBeyondLegacyPrefix() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        Configurator.getInstance().uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        val device = UiDevice.getInstance(instrumentation)
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim())
        instrumentation.targetContext.startActivity(
            Intent()
                .setClassName("com.yepcontrol.app.test", "dev.remoteaccess.app.QueryFixtureActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        assertTrue(device.wait(Until.hasObject(By.text("Beyond prefix")), 10000))
        val probe = SemanticAccess()
        val owner = Any()

        fun observe(request: ControlCommand? = null): JSONObject {
            var result: JSONObject? = null
            val deadline = android.os.SystemClock.elapsedRealtime() + 10000
            while (result == null && android.os.SystemClock.elapsedRealtime() < deadline) {
                instrumentation.runOnMainSync {
                    val root = instrumentation.uiAutomation.rootInActiveWindow
                    if (root != null) {
                        if (root.packageName?.toString() == "com.yepcontrol.app.test") {
                            result = JSONObject(String(assertNotNull(probe.snapshot(owner, root, request))))
                        } else {
                            root.recycle()
                        }
                    }
                }
                if (result == null) Thread.sleep(50)
            }
            return assertNotNull(result)
        }

        fun query(
            name: String,
            nodes: Int = 1024,
            matches: Int = 32,
        ): JSONObject = observe(ControlCommand(1, 29, listOf(nodes, 32, matches, 1500), JSONObject().put("name", name).toString()))

        fun act(
            snapshot: JSONObject,
            node: Int,
            actor: Any = owner,
            allowed: Boolean = true,
        ): Int {
            var result = -1
            instrumentation.runOnMainSync {
                result =
                    probe.act(
                        actor,
                        ControlCommand(2, 21, listOf(node), observation = snapshot.getString("observation")),
                        assertNotNull(instrumentation.uiAutomation.rootInActiveWindow),
                    ) { allowed }
            }
            return result
        }
        try {
            val legacy = observe()
            assertTrue(legacy.getBoolean("truncated"))
            assertEquals(128, legacy.getJSONArray("nodes").length())
            val full = observe(ControlCommand(1, 28, listOf(1024, 32, 0, 1500)))
            assertFalse(full.getBoolean("truncated"), full.toString())
            assertTrue(full.getJSONArray("nodes").length() > 128)
            val target =
                (0 until full.getJSONArray("nodes").length())
                    .map { full.getJSONArray("nodes").getJSONObject(it) }
                    .single { it.getString("text") == "Beyond prefix" }
            assertTrue(target.getInt("node") >= 128)
            assertTrue(target.getBoolean("enabled"))
            assertEquals(0, act(full, target.getInt("node")))
            assertTrue(device.wait(Until.hasObject(By.text("Query taps: 1")), 5000))

            val sparse = query("Query taps: 1")
            assertFalse(sparse.getBoolean("truncated"), sparse.toString())
            assertTrue(sparse.getInt("visitedNodes") > 128)
            assertTrue(sparse.getJSONArray("nodes").length() < 10)
            assertEquals(1, sparse.getJSONArray("matches").length())
            assertNotNull(device.findObject(By.text("Query taps: 1"))).click()
            assertTrue(device.wait(Until.hasObject(By.text("Query taps: 2")), 5000))
            assertEquals(2, act(sparse, sparse.getJSONArray("matches").getInt(0)))
            assertTrue(device.hasObject(By.text("Query taps: 2")))
            val revoked = query("Query taps: 2")
            assertEquals(8, act(revoked, revoked.getJSONArray("matches").getInt(0), allowed = false))
            assertTrue(device.hasObject(By.text("Query taps: 2")))

            val duplicate = query("Repeated marker")
            assertFalse(duplicate.getBoolean("truncated"))
            assertEquals(3, duplicate.getJSONArray("matches").length())
            val limited = query("Repeated marker", matches = 1)
            assertTrue(limited.getBoolean("truncated"))
            assertTrue(limited.getJSONArray("limitReasons").toString().contains("matches"))
            val prefix = query("Query taps: 2", nodes = 32)
            assertTrue(prefix.getBoolean("truncated"))
            assertEquals(0, prefix.getJSONArray("matches").length())
            val empty = query("Nothing with this name")
            assertFalse(empty.getBoolean("truncated"))
            assertEquals(0, empty.getJSONArray("matches").length())
            val protected = query("Private descendant")
            assertFalse(protected.getBoolean("truncated"))
            assertEquals(0, protected.getJSONArray("matches").length())
            assertFalse(protected.toString().contains("Private descendant"))
        } finally {
            instrumentation.runOnMainSync { probe.clear() }
        }
    }
}

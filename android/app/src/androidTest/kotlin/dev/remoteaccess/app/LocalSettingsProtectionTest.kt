package dev.remoteaccess.app

import android.app.UiAutomation
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.view.inspector.WindowInspector
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import androidx.work.WorkManager
import dev.remoteaccess.app.control.ControlSession
import dev.remoteaccess.app.control.LocalSettingsProtection
import dev.remoteaccess.app.control.ScreenAccessService
import dev.remoteaccess.app.unlock.PinVault
import dev.remoteaccess.protocol.ControlCommand
import dev.remoteaccess.protocol.Crypto
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Real native commands versus local UI input, confined to the mobile runner's disposable emulator. */
@RunWith(AndroidJUnit4::class)
class LocalSettingsProtectionTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device =
        run {
            Configurator.getInstance().uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
            UiDevice.getInstance(instrumentation)
        }
    private val replies = LinkedBlockingQueue<ByteArray>()
    private val id = "a".repeat(32)
    private lateinit var owner: ControlSession
    private var sequence = 0

    private fun waitFor(predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (predicate()) return
            Thread.sleep(80)
        }
        error("Local settings state did not arrive")
    }

    private fun view(selector: BySelector) = assertNotNull(device.wait(Until.findObject(selector), 10000))

    private fun <T> withView(
        selector: BySelector,
        action: (UiObject2) -> T,
    ): T {
        val deadline = SystemClock.elapsedRealtime() + 10000
        while (SystemClock.elapsedRealtime() < deadline) {
            try {
                device.findObject(selector)?.let { return action(it) }
            } catch (_: StaleObjectException) {
                // Readiness/store refreshes can replace a node after lookup.
                // Reacquire UI nodes only; remote commands must never be retried here.
            }
            Thread.sleep(100)
        }
        error("Native control did not become available: $selector")
    }

    private fun selector(id: String) = By.res("${context.packageName}:id/$id")

    private fun click(id: String) {
        withView(selector(id)) { it.click() }
        instrumentation.waitForIdleSync()
    }

    private fun activity() =
        ActivityLifecycleMonitorRegistry
            .getInstance()
            .getActivitiesInStage(Stage.RESUMED)
            .filterIsInstance<MainActivity>()
            .single()

    private fun command(
        op: Int,
        payload: ByteArray = byteArrayOf(),
    ): ByteArray {
        owner.receive(
            ByteBuffer
                .allocate(12 + payload.size)
                .putInt(0x41524331)
                .put(op.toByte())
                .put(byteArrayOf(0, 0, 0))
                .putInt(++sequence)
                .put(payload)
                .array(),
        )
        return assertNotNull(replies.poll(10, TimeUnit.SECONDS), "Missing native command reply")
    }

    private fun result(
        code: Int,
        reply: ByteArray,
    ) {
        assertEquals(2, reply[4].toInt())
        assertEquals(code, reply.last().toInt())
    }

    private fun status(): JSONObject {
        val bytes = command(2)
        return JSONObject(bytes.copyOfRange(12, bytes.size).toString(Charsets.UTF_8))
    }

    private fun capture(): Int {
        var scene = 0
        waitFor {
            val reply = command(3)
            scene = if (reply[4].toInt() == 3) ByteBuffer.wrap(reply).getInt(12) else 0
            scene != 0
        }
        return scene
    }

    private fun tap(
        id: String,
        scene: Int,
    ): ByteArray {
        device.waitForIdle()
        val bounds = withView(selector(id)) { it.visibleBounds }
        return command(
            4,
            ByteBuffer
                .allocate(12)
                .putInt(scene)
                .putInt(bounds.centerX())
                .putInt(bounds.centerY())
                .array(),
        )
    }

    private fun touch(
        scene: Int,
        sequence: Int = 0,
    ): ByteArray =
        ByteBuffer
            .allocate(32)
            .putInt(scene)
            .putInt(1)
            .putInt(sequence)
            .putShort(40)
            .put(1)
            .put(0)
            .putInt(0)
            .put(1)
            .put(1)
            .putShort(0)
            .putFloat(100f)
            .putFloat(1600f)
            .array()

    private fun settings() {
        click("navigation_menu")
        click("open_settings")
    }

    @Test fun securitySettingsRequireLocalInput() {
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim(), "Owned emulator only")
        val store = HostStore.get(context).load()
        val vault = PinVault(context)
        assertFalse(vault.saved(), "The runner must start with cleared disposable app data")
        store.pair(JSONObject().put("id", id).put("origin", BuildConfig.SHARING_WEBSITE), "Security fixture")
        owner = ControlSession(context, id, { true }, { replies.offer(it) })
        device.executeShellCommand(
            "settings put secure enabled_accessibility_services com.yepcontrol.app/dev.remoteaccess.app.control.ScreenAccessService",
        )
        device.executeShellCommand("settings put secure accessibility_enabled 1")
        waitFor { ScreenAccessService.current != null }
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        try {
            click("navigation_menu")
            click("open_devices")
            withView(By.descStartsWith("Security fixture. ")) { it.click() }
            view(selector("unlock_settings"))
            assertFalse(status().getBoolean("localSettings"))

            // A held remote contact must be released before sensitive controls appear.
            var scene = 0
            waitFor {
                scene = capture()
                val reply = command(11, touch(scene))
                if (reply[4].toInt() == 2 && reply.last().toInt() == 2) {
                    false // A late window/rotation event invalidated the frame before dispatch.
                } else {
                    result(0, reply)
                    true
                }
            }
            instrumentation.runOnMainSync { activity().findViewById<View>(R.id.unlock_settings).performClick() }
            view(selector("allow_unlock"))
            instrumentation.runOnMainSync { assertFalse(assertNotNull(ScreenAccessService.current).inputInFlight) }
            assertTrue(status().getBoolean("localSettings"))
            assertTrue(withView(selector("local_settings_notice")) { it.text }.contains("unrestricted remote control is off"))
            result(4, tap("allow_unlock", capture()))
            result(4, command(11, touch(scene, 1)))
            result(
                4,
                command(
                    5,
                    ByteBuffer
                        .allocate(24)
                        .putInt(scene)
                        .putInt(100)
                        .putInt(200)
                        .putInt(100)
                        .putInt(300)
                        .putInt(100)
                        .array(),
                ),
            )
            assertFalse(assertNotNull(store.device(id)).unlockAllowed)
            assertTrue(device.takeScreenshot(File(context.filesDir, "ui-local-settings.png")))

            // Local input still changes the real durable setting, including after rotation.
            device.setOrientationLeft()
            view(selector("allow_unlock"))
            assertTrue(status().getBoolean("localSettings"))
            click("allow_unlock")
            waitFor { store.device(id)?.unlockAllowed == true }
            device.setOrientationNatural()
            result(0, command(6, byteArrayOf(1))) // Remote Back exits the protected screen.
            waitFor { !LocalSettingsProtection.blocked }
            view(selector("unlock_settings"))

            // A queued command remains invalid even if the protected screen has closed again.
            val queued = LinkedBlockingQueue<Int>()
            instrumentation.runOnMainSync {
                assertNotNull(
                    ScreenAccessService.current,
                ).execute(ControlCommand(1, 7, text = "queued input"), owner, { true }) { _, bytes ->
                    queued.offer(bytes.single().toInt())
                }
                activity().findViewById<View>(R.id.unlock_settings).performClick()
                activity().onBackPressedDispatcher.onBackPressed()
            }
            assertEquals(4, queued.poll(10, TimeUnit.SECONDS))

            click("navigate_back")
            settings()
            // Remote taps can still navigate ordinary settings and open the protected detail page.
            result(0, tap("saved_pin_settings", capture()))
            view(selector("save_pin"))
            assertTrue(status().getBoolean("localSettings"))
            result(4, tap("save_pin", capture()))
            assertFalse(vault.saved())
            click("save_pin")
            click("save_pin_value")
            result(4, command(7, "123456".toByteArray()))
            instrumentation.runOnMainSync {
                val root = WindowInspector.getGlobalWindowViews().first { it.findViewById<View>(R.id.save_pin_value) != null }
                val value = root.findViewById<EditText>(R.id.save_pin_value)
                val confirmation = root.findViewById<EditText>(R.id.save_pin_confirm)
                assertEquals("", value.text.toString(), "Remote text must not reach the secure PIN editor")
                // Password fields hide text from accessibility on some emulator images.
                // Seed only this synthetic editor fixture; local Save still uses real UI input.
                value.setText("314159")
                confirmation.setText("314159")
            }
            instrumentation.waitForIdleSync()
            device.waitForIdle()
            withView(By.res("android:id/button1")) { it.click() }
            try {
                waitFor { vault.saved() }
            } catch (error: Throwable) {
                var diagnostic = "editor closed"
                instrumentation.runOnMainSync {
                    WindowInspector.getGlobalWindowViews().firstOrNull { it.findViewById<View>(R.id.save_pin_value) != null }?.let { root ->
                        val value = root.findViewById<EditText>(R.id.save_pin_value)
                        val confirmation = root.findViewById<EditText>(R.id.save_pin_confirm)
                        diagnostic = "lengths=${value.length()}/${confirmation.length()}, error=${confirmation.error}"
                    }
                }
                throw AssertionError("Synthetic PIN save failed: $diagnostic", error)
            }
            click("save_pin")
            val forget = withView(By.res("android:id/button1")) { it.visibleBounds }
            result(
                4,
                command(
                    4,
                    ByteBuffer
                        .allocate(12)
                        .putInt(1)
                        .putInt(forget.centerX())
                        .putInt(forget.centerY())
                        .array(),
                ),
            )
            assertTrue(vault.saved())
            withView(By.res("android:id/button1")) { it.click() }
            waitFor { !vault.saved() }
            result(0, command(6, byteArrayOf(2))) // Home also exits when the PIN editor left an IME open.
            waitFor { !LocalSettingsProtection.blocked }
            assertTrue(device.wait(Until.hasObject(By.pkg("com.google.android.apps.nexuslauncher")), 10000))

            // A remote viewer cannot create or capture the phone's bearer code.
            context.startActivity(
                Intent(context, MainActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK,
                ),
            )
            view(selector("host_status"))
            click("pair_device")
            view(selector("give_control"))
            assertTrue(LocalSettingsProtection.hideCapture)
            instrumentation.runOnMainSync {
                assertTrue(activity().window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertEquals(
                    GiveControl.Phase.IDLE,
                    androidx.lifecycle
                        .ViewModelProvider(activity())[GiveControl::class.java]
                        .state.phase,
                )
            }
            result(4, command(3))
            result(4, tap("give_control", scene))
            instrumentation.runOnMainSync {
                assertEquals(
                    GiveControl.Phase.IDLE,
                    androidx.lifecycle
                        .ViewModelProvider(activity())[GiveControl::class.java]
                        .state.phase,
                )
            }
            device.pressBack()
            waitFor { !LocalSettingsProtection.hideCapture }

            // A valid incoming invitation cannot be approved by another paired device's input.
            val invitation =
                JSONObject()
                    .put("v", 1)
                    .put("origin", Website.current(context))
                    .put("id", "b".repeat(32))
                    .put("viewer", encoded(Crypto.publicBytes(Crypto.generate().public)))
                    .put("secret", "c".repeat(64))
                    .put("expires", System.currentTimeMillis() / 1000 + 300)
                    .put("name", "Unapproved fixture")
            context.startActivity(
                Intent(
                    context,
                    MainActivity::class.java,
                ).setData(Uri.parse("${Website.current(context)}/enroll#${encoded(invitation.toString().toByteArray())}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
            )
            view(selector("grant_device"))
            result(4, tap("grant_device", capture()))
            assertEquals(1, store.snapshot.devices.size)
            result(0, command(6, byteArrayOf(2))) // Remote Home remains an escape route.
            waitFor { !LocalSettingsProtection.blocked }
        } catch (error: Throwable) {
            device.takeScreenshot(File(context.filesDir, "ui-local-settings-failure.png"))
            throw error
        } finally {
            owner.close()
            vault.forget()
            WorkManager
                .getInstance(context)
                .cancelAllWork()
                .result
                .get(10, TimeUnit.SECONDS)
            store.revoke(id)
            store.removed(id)
            device.setOrientationNatural()
            device.unfreezeRotation()
        }
    }

    @Test fun unrestrictedConfigurationCanBeEnabledRemotelyAndProtectionReturnsImmediately() {
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim(), "Owned emulator only")
        val store = HostStore.get(context).load()
        store.unrestrictedRemoteControl(false)
        val vault = PinVault(context)
        store.pair(JSONObject().put("id", id).put("origin", BuildConfig.SHARING_WEBSITE), "Configuration fixture")
        owner = ControlSession(context, id, { true }, { replies.offer(it) })
        device.executeShellCommand(
            "settings put secure enabled_accessibility_services com.yepcontrol.app/dev.remoteaccess.app.control.ScreenAccessService",
        )
        device.executeShellCommand("settings put secure accessibility_enabled 1")
        waitFor { ScreenAccessService.current != null }
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )

        fun androidButton(scene: Int): ByteArray {
            device.waitForIdle()
            val bounds = withView(By.res("android:id/button1")) { it.visibleBounds }
            return command(
                4,
                ByteBuffer
                    .allocate(12)
                    .putInt(scene)
                    .putInt(bounds.centerX())
                    .putInt(bounds.centerY())
                    .array(),
            )
        }
        try {
            settings()
            repeat(2) {
                val scene = capture()
                result(
                    0,
                    command(
                        5,
                        ByteBuffer
                            .allocate(24)
                            .putInt(scene)
                            .putInt(device.displayWidth / 2)
                            .putInt(device.displayHeight * 4 / 5)
                            .putInt(device.displayWidth / 2)
                            .putInt(device.displayHeight / 3)
                            .putInt(300)
                            .array(),
                    ),
                )
                Thread.sleep(400)
            }
            result(0, tap("unrestricted_remote_control", capture()))
            view(By.text("Allow unrestricted remote control?"))
            assertTrue(withView(By.textContains("Their access lasts until")) { it.text }.contains("unlock settings"))
            result(0, androidButton(capture()))
            waitFor { store.snapshot.settings.unrestrictedRemoteControl && LocalSettingsProtection.unrestricted }
            result(0, command(6, byteArrayOf(1)))
            view(selector("host_status"))
            settings()
            result(0, tap("saved_pin_settings", capture()))
            view(selector("save_pin"))
            assertFalse(status().getBoolean("localSettings"))
            result(0, tap("save_pin", capture()))
            view(selector("save_pin_value"))
            instrumentation.runOnMainSync {
                val root = WindowInspector.getGlobalWindowViews().first { it.findViewById<View>(R.id.save_pin_value) != null }
                assertTrue(root.layoutParams is android.view.WindowManager.LayoutParams)
                assertEquals(
                    0,
                    (root.layoutParams as android.view.WindowManager.LayoutParams).flags and
                        android.view.WindowManager.LayoutParams.FLAG_SECURE,
                )
            }
            // Real remote text operations configure a synthetic saved PIN on this owned emulator.
            result(0, tap("save_pin_value", capture()))
            waitFor { withView(selector("save_pin_value")) { it.isFocused } }
            result(0, command(7, "314159".toByteArray()))
            result(0, tap("save_pin_confirm", capture()))
            waitFor { withView(selector("save_pin_confirm")) { it.isFocused } }
            result(0, command(7, "314159".toByteArray()))
            instrumentation.runOnMainSync {
                val root = WindowInspector.getGlobalWindowViews().first { it.findViewById<View>(R.id.save_pin_value) != null }
                assertEquals("314159", root.findViewById<EditText>(R.id.save_pin_value).text.toString())
                assertEquals("314159", root.findViewById<EditText>(R.id.save_pin_confirm).text.toString())
            }
            result(0, androidButton(capture()))
            waitFor { vault.saved() }
            assertFalse(assertNotNull(store.device(id)).unlockAllowed, "Saving a PIN does not grant unlock authority")
            result(0, tap("save_pin", capture()))
            view(By.text("Forget saved PIN?"))
            result(0, androidButton(capture()))
            waitFor { !vault.saved() }
            result(0, tap("save_pin", capture()))
            view(selector("save_pin_value"))
            // A background policy write closes the editor and fences already queued input.
            val queued = LinkedBlockingQueue<Int>()
            instrumentation.runOnMainSync {
                assertNotNull(
                    ScreenAccessService.current,
                ).execute(ControlCommand(1, 7, text = "queued input"), owner, { true }) { _, bytes ->
                    queued.offer(bytes.single().toInt())
                }
                LocalSettingsProtection.configure(false)
            }
            assertEquals(4, queued.poll(10, TimeUnit.SECONDS))
            store.unrestrictedRemoteControl(false)
            waitFor { !device.hasObject(selector("save_pin_value")) && LocalSettingsProtection.blocked }
            result(4, tap("save_pin", capture()))
            assertFalse(vault.saved())
            // Re-enable for pairing-page visibility, then disable without leaving it.
            store.unrestrictedRemoteControl(true)
            result(0, command(6, byteArrayOf(2)))
            assertTrue(device.wait(Until.hasObject(By.pkg("com.google.android.apps.nexuslauncher")), 10000))
            context.startActivity(
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
            )
            view(selector("host_status"))
            click("pair_device")
            view(selector("give_control"))
            assertFalse(LocalSettingsProtection.blocked)
            assertFalse(LocalSettingsProtection.hideCapture)
            instrumentation.runOnMainSync {
                assertEquals(0, activity().window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE)
            }
            val observation = command(20)
            assertEquals(7, observation[4].toInt())
            capture()
            store.unrestrictedRemoteControl(false)
            waitFor { LocalSettingsProtection.hideCapture }
            instrumentation.runOnMainSync {
                assertTrue(activity().window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0)
            }
            result(4, command(20))
            result(4, command(3))
            result(0, command(6, byteArrayOf(2)))
            waitFor { !LocalSettingsProtection.blocked }
        } catch (error: Throwable) {
            device.takeScreenshot(File(context.filesDir, "ui-unrestricted-failure.png"))
            device.dumpWindowHierarchy(File(context.filesDir, "unrestricted-failure.xml"))
            throw error
        } finally {
            owner.close()
            vault.forget()
            store.unrestrictedRemoteControl(false)
            store.revoke(id)
            store.removed(id)
        }
    }
}

package dev.remoteaccess.app

import android.app.UiModeManager
import android.content.Intent
import android.util.TypedValue
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.mlkit.common.MlKitException
import dev.remoteaccess.protocol.Crypto
import dev.remoteaccess.protocol.JcaIdentity
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Run on an owned emulator. Exercises real navigation, recreation and Android theme changes. */
@RunWith(AndroidJUnit4::class)
class MobileNavigationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)

    private fun click(id: String) {
        val selector = By.res("${context.packageName}:id/$id")
        val deadline = System.nanoTime() + 10_000_000_000L
        while (System.nanoTime() < deadline) {
            try {
                val view = device.findObject(selector)
                if (view != null && view.isEnabled) {
                    view.click()
                    instrumentation.waitForIdleSync()
                    return
                }
            } catch (_: StaleObjectException) {
                // Theme/configuration changes can replace the Activity between lookup and click.
                // Reacquire the node; never repeat a click that completed successfully.
            }
            Thread.sleep(100)
        }
        error("Native control did not become clickable: $id")
    }

    private fun title(expected: String) {
        assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/page_title").text(expected)), 10000))
    }

    private fun start() {
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        title("This phone")
        assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/host_status")), 10000))
    }

    private fun settings() {
        click("navigation_menu")
        click("open_settings")
        title("Settings")
    }

    private fun shot(name: String) {
        assertTrue(device.takeScreenshot(File(context.filesDir, "ui-$name.png")))
    }

    private fun themed(dark: Boolean) {
        val expected = if (dark) 0xff121914.toInt() else 0xfff5f7f5.toInt()
        val deadline = System.nanoTime() + 10_000_000_000L
        var actual = 0
        while (actual != expected && System.nanoTime() < deadline) {
            instrumentation.runOnMainSync {
                val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull()
                if (activity != null) {
                    actual = TypedValue().also { activity.theme.resolveAttribute(android.R.attr.colorBackground, it, true) }.data
                }
            }
            if (actual != expected) Thread.sleep(100)
        }
        assertEquals(expected, actual, "The visible activity must adopt the selected theme")
    }

    private fun scannerLifecycle() {
        lateinit var scanner: PairingScanner
        instrumentation.runOnMainSync {
            val activity =
                ActivityLifecycleMonitorRegistry
                    .getInstance()
                    .getActivitiesInStage(
                        Stage.RESUMED,
                    ).filterIsInstance<MainActivity>()
                    .single()
            scanner = ViewModelProvider(activity)[PairingScanner::class.java]
        }
        val original = scanner.open
        val calls = AtomicInteger()
        var next = TaskCompletionSource<String>()
        instrumentation.runOnMainSync {
            scanner.open = {
                calls.incrementAndGet()
                next.task
            }
        }
        val scan = By.res("${context.packageName}:id/scan_pairing_code")

        fun enabled(value: Boolean) = By.res("${context.packageName}:id/scan_pairing_code").enabled(value)
        val progress = By.res("${context.packageName}:id/scanner_progress")
        val key = Crypto.generate().let { JcaIdentity(it.private, it.public) }
        val origin = Website.current(context)
        val invitation =
            JSONObject()
                .put("v", 1)
                .put("origin", origin)
                .put("id", "33".repeat(16))
                .put("secret", "44".repeat(32))
                .put("viewer", encoded(key.publicKey))
                .put("expires", System.currentTimeMillis() / 1000 + 300)
                .put("name", "Fixture controlling browser")
        val link = "$origin/enroll#${encoded(invitation.toString().toByteArray(Charsets.UTF_8))}"
        try {
            click("scan_pairing_code")
            assertTrue(device.wait(Until.hasObject(progress), 1000), "The first tap must immediately show progress")
            assertTrue(device.hasObject(enabled(false)))
            val bounds = assertNotNull(device.findObject(scan)).visibleBounds
            device.click(bounds.centerX(), bounds.centerY())
            assertEquals(1, calls.get(), "Repeated taps must not launch a second scanner")
            shot("scanner-opening")
            device.setOrientationLeft()
            title("Allow a browser")
            device.setOrientationNatural()
            title("Allow a browser")
            assertTrue(device.wait(Until.hasObject(progress), 10000))
            assertEquals(1, calls.get(), "Recreation must keep the original pending scanner")
            instrumentation.runOnMainSync { next.setException(IllegalStateException("fixture scanner failure")) }
            assertTrue(device.wait(Until.hasObject(enabled(true)), 10000))
            assertTrue(device.hasObject(By.textStartsWith("Couldn’t open the scanner.")))

            val cancellation = CancellationTokenSource()
            next = TaskCompletionSource(cancellation.token)
            click("scan_pairing_code")
            assertTrue(device.wait(Until.hasObject(progress), 1000))
            instrumentation.runOnMainSync { cancellation.cancel() }
            assertTrue(device.wait(Until.hasObject(enabled(true)), 10000))
            assertFalse(device.hasObject(By.textStartsWith("Couldn’t open the scanner.")))

            // Play services can report the scanner's Close/Back action as this
            // documented failure rather than cancelling its Task.
            next = TaskCompletionSource()
            click("scan_pairing_code")
            instrumentation.runOnMainSync {
                next.setException(MlKitException("Fixture scanner closed", MlKitException.CODE_SCANNER_CANCELLED))
            }
            assertTrue(device.wait(Until.hasObject(enabled(true)), 10000))
            assertFalse(device.hasObject(By.textStartsWith("Couldn’t open the scanner.")))

            next = TaskCompletionSource()
            click("scan_pairing_code")
            assertTrue(device.wait(Until.hasObject(progress), 1000))
            device.pressBack()
            title("Allowed browsers")
            instrumentation.runOnMainSync { next.setResult(link) }
            instrumentation.waitForIdleSync()
            title("Allowed browsers")
            assertFalse(device.hasObject(By.res("${context.packageName}:id/grant_device")), "A late scan must not navigate after Back")

            click("pair_device")
            next = TaskCompletionSource()
            click("scan_pairing_code")
            instrumentation.runOnMainSync { next.setResult(link) }
            title("Allow this browser?")
            assertTrue(device.hasObject(By.text("Fixture controlling browser")))
            click("cancel_grant")
            title("This phone")
        } finally {
            instrumentation.runOnMainSync { scanner.open = original }
        }
    }

    @Test
    fun navigationAndAppearance() {
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim(), "Owned emulator only")
        val previousMode = context.getSystemService(UiModeManager::class.java).nightMode
        val previousChoice = Appearance.choice(context)
        try {
            Appearance.save(context, "light")
            start()
            themed(false)
            assertFalse(device.hasObject(By.res("${context.packageName}:id/device_toggle")))
            assertFalse(device.hasObject(By.res("${context.packageName}:id/manage_access")))
            shot("light-home")
            click("navigation_menu")
            assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/open_home").selected(true)), 10000))
            shot("light-drawer")
            device.pressBack()
            title("This phone")
            assertTrue(device.wait(Until.gone(By.res("${context.packageName}:id/open_settings")), 10000))
            click("navigation_menu")
            click("open_devices")
            title("Allowed browsers")
            settings()
            shot("light-settings")
            assertTrue(device.hasObject(By.res("${context.packageName}:id/screen_access")))
            click("background_settings")
            title("Connection details")
            val bar = assertNotNull(device.findObject(By.res("${context.packageName}:id/page_title"))).visibleBounds
            device.swipe(device.displayWidth / 2, device.displayHeight * 4 / 5, device.displayWidth / 2, device.displayHeight / 3, 20)
            assertEquals(bar, assertNotNull(device.findObject(By.res("${context.packageName}:id/page_title"))).visibleBounds)
            click("navigate_back")
            title("Settings")
            click("appearance_settings")
            title("Appearance")
            click("appearance_dark")
            themed(true)
            title("Appearance")
            assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/appearance_dark").checked(true)), 10000))
            shot("dark-appearance")
            device.pressBack()
            title("Settings")
            shot("dark-settings")
            click("navigation_menu")
            shot("dark-drawer")
            click("open_home")
            title("This phone")
            shot("dark-home")
            // Restarting the task must retain the preference and native dialog styling.
            start()
            themed(true)
            assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/scan_pairing_code")), 10000))
            shot("dark-home-pairing")
            assertFalse(device.hasObject(By.res("${context.packageName}:id/sharing_website")))
            click("pair_device")
            title("Allow a browser")
            assertTrue(device.hasObject(By.res("${context.packageName}:id/scan_pairing_code")))
            assertTrue(device.hasObject(By.res("${context.packageName}:id/sharing_website")))
            shot("dark-add-device")
            device.pressBack()
            title("This phone")
            click("navigation_menu")
            click("open_devices")
            click("pair_device")
            title("Allow a browser")
            device.pressBack()
            title("Allowed browsers")
            click("pair_device")
            scannerLifecycle()
            settings()
            click("appearance_settings")
            click("appearance_light")
            themed(false)
            device.executeShellCommand("cmd uimode night yes")
            themed(false) // An explicit Light choice takes precedence over Android's setting.
            shot("light-overrides-dark-system")
            click("appearance_system")
            themed(true)
            device.executeShellCommand("cmd uimode night no")
            themed(false)
            // Recreation must retain the current detail screen and its navigation parent.
            device.setOrientationLeft()
            title("Appearance")
            shot("landscape-appearance")
            device.pressBack()
            title("Settings")
            device.setOrientationNatural()
            click("navigation_menu")
            click("open_activity")
            title("Activity")
            shot("activity")
        } finally {
            Appearance.save(context, previousChoice)
            val mode =
                when (previousMode) {
                    UiModeManager.MODE_NIGHT_YES -> "yes"
                    UiModeManager.MODE_NIGHT_NO -> "no"
                    else -> "auto"
                }
            device.executeShellCommand("cmd uimode night $mode")
            device.setOrientationNatural()
            device.unfreezeRotation()
        }
    }
}

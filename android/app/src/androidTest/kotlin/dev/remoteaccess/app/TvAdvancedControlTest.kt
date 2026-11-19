package dev.remoteaccess.app

import android.app.UiAutomation
import android.content.Intent
import android.os.SystemClock
import android.provider.Settings
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import dev.remoteaccess.app.advanced.AdvancedControl
import dev.remoteaccess.app.control.ScreenAccessService
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.regex.Pattern
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Run explicitly on a fresh, owned Google TV AVD after enabling Wireless debugging and screen access. */
@RunWith(AndroidJUnit4::class)
class TvAdvancedControlTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)

    private fun id(name: String) = By.res(context.packageName, name)

    private fun select(
        selector: BySelector,
        move: () -> Boolean = device::pressDPadDown,
    ) {
        repeat(18) {
            val view = device.findObject(selector)
            val focused = device.findObject(By.focused(true))
            if (view?.isFocused == true || focused?.hasObject(selector) == true) {
                device.pressDPadCenter()
                return
            }
            move()
            SystemClock.sleep(200)
        }
        error("Control did not receive D-pad focus")
    }

    @Test
    fun keypadPairsWhileAndroidSettingsIsOpen() {
        Configurator.getInstance().uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        assumeTrue(context.isTv() && device.executeShellCommand("getprop ro.kernel.qemu").trim() == "1")
        assumeTrue(Settings.Global.getInt(context.contentResolver, "adb_wifi_enabled", 0) == 1)
        assumeTrue(!AdvancedControl.paired(context))
        val accessibility = "enabled_accessibility_services"
        val previous = Settings.Secure.getString(context.contentResolver, accessibility).orEmpty()
        val service = "${context.packageName}/${ScreenAccessService::class.java.name}"
        assumeTrue(service in previous.split(':'))
        // Instrumentation can restart the host process, which leaves Android's binding marked crashed.
        device.executeShellCommand("settings delete secure $accessibility")
        device.executeShellCommand("settings put secure $accessibility $service")
        try {
            val boundBy = SystemClock.elapsedRealtime() + 8000
            while (ScreenAccessService.current == null && SystemClock.elapsedRealtime() < boundBy) SystemClock.sleep(100)
            assertNotNull(ScreenAccessService.current, "The emulator could not bind the test app's screen access")
            context.startActivity(
                Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
                    .setClassName(context.packageName, "dev.remoteaccess.app.TvLauncher")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
            )
            assertTrue(device.wait(Until.hasObject(id("host_status")), 10000))
            select(id("navigation_menu"), device::pressDPadUp)
            assertTrue(device.wait(Until.hasObject(id("open_settings")), 5000))
            select(id("open_settings"))
            select(id("advanced_settings"))
            select(id("advanced_start"))
            assertTrue(device.wait(Until.hasObject(By.res("android", "button1")), 5000))
            select(By.res("android", "button1"), device::pressDPadRight)
            assertTrue(device.wait(Until.hasObject(id("advanced_stop")), 5000))
            select(id("advanced_developer"))
            assertTrue(device.wait(Until.hasObject(By.text("Developer options")), 5000))
            select(By.text("Wireless debugging"))
            select(By.text("Pair device with pairing code"))

            val codePattern = Pattern.compile("(?s).*\\b([0-9]{6})\\b.*")
            val codeNode = assertNotNull(device.wait(Until.findObject(By.text(codePattern)), 15000))
            val code =
                codePattern.matcher(codeNode.text).let { matcher ->
                    check(matcher.matches())
                    matcher.group(1)!!
                }
            assertTrue(device.wait(Until.hasObject(By.text(context.getString(R.string.tv_android_code_title))), 15000))
            var row = 0
            var column = 0
            for (digit in code) {
                val key = digit.digitToInt()
                val nextRow = if (key == 0) 3 else (key - 1) / 3
                val nextColumn = if (key == 0) 1 else (key - 1) % 3
                repeat(kotlin.math.abs(nextColumn - column)) {
                    if (nextColumn < column) device.pressDPadLeft() else device.pressDPadRight()
                }
                repeat(kotlin.math.abs(nextRow - row)) {
                    if (nextRow < row) device.pressDPadUp() else device.pressDPadDown()
                }
                assertTrue(device.hasObject(By.text(digit.toString()).focused(true)), "Keypad focus did not move")
                device.pressDPadCenter()
                row = nextRow
                column = nextColumn
            }
            repeat(3 - row) { device.pressDPadDown() }
            repeat(2 - column) { device.pressDPadRight() }
            assertTrue(device.hasObject(By.text("Pair").focused(true)))
            device.pressDPadCenter()

            val deadline = SystemClock.elapsedRealtime() + 35000
            while (!AdvancedControl.ready() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100)
            assertTrue(AdvancedControl.paired(context), "Android did not accept the locally entered code")
            assertTrue(AdvancedControl.ready(), "The paired advanced helper did not start")
            assertFalse(device.hasObject(By.text(context.getString(R.string.tv_android_code_title))))
        } finally {
            AdvancedControl.stop(context)
            device.executeShellCommand("settings put secure $accessibility $previous")
        }
    }
}

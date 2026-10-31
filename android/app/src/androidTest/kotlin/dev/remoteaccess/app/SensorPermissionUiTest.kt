package dev.remoteaccess.app

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleCallback
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import dev.remoteaccess.app.media.MediaController
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Restored result callbacks must retain the specific consent, without starting a sensor. */
@RunWith(AndroidJUnit4::class)
class SensorPermissionUiTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)

    private fun waitFor(predicate: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < until) {
            if (predicate()) return
            Thread.sleep(100)
        }
        error("Sensor consent did not survive recreation")
    }

    private fun click(id: String) {
        val selector = By.res("${context.packageName}:id/$id")
        waitFor {
            val node = device.findObject(selector)
            if (node != null) {
                node.click()
                true
            } else {
                if (id in listOf("allow_camera", "allow_microphone")) device.findObject(By.scrollable(true))?.scroll(Direction.DOWN, 0.5f)
                false
            }
        }
    }

    private fun consent(camera: Boolean) {
        assertTrue(device.executeShellCommand("getprop ro.kernel.qemu").trim() == "1", "Owned emulator only")
        val store = HostStore.get(context).load()
        store.media(cameraAllowed = false, microphoneAllowed = false)
        assertFalse(MediaController.permission(context, camera), "Runner must supply a fresh permission state")
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK,
            ),
        )
        click("navigation_menu")
        click("open_settings")
        val original = AtomicReference<Activity>()
        instrumentation.runOnMainSync {
            original.set(
                ActivityLifecycleMonitorRegistry
                    .getInstance()
                    .getActivitiesInStage(Stage.RESUMED)
                    .filterIsInstance<MainActivity>()
                    .single(),
            )
        }
        click(if (camera) "allow_camera" else "allow_microphone")
        assertNotNull(device.wait(Until.findObject(By.text(if (camera) "Allow remote camera?" else "Allow remote microphone?")), 10000))
        assertNotNull(device.findObject(By.res("android:id/button1"))).click()
        val grant = By.res("com.android.permissioncontroller:id/permission_allow_foreground_only_button")
        assertNotNull(device.wait(Until.findObject(grant), 10000))
        val replacement = AtomicReference<Activity>()
        val observer =
            ActivityLifecycleCallback { activity, stage ->
                if (activity is MainActivity && activity !== original.get() && stage == Stage.CREATED) replacement.set(activity)
            }
        ActivityLifecycleMonitorRegistry.getInstance().addLifecycleCallback(observer)
        try {
            instrumentation.runOnMainSync { original.get().recreate() }
            waitFor { replacement.get() != null }
            assertNotNull(device.wait(Until.findObject(grant), 10000)).click()
            waitFor { MediaController.permission(context, camera) && MediaController.allowed(context, camera) }
            assertFalse(MediaController.allowed(context, !camera), "Consent must not enable the other sensor")
            instrumentation.runOnMainSync {
                val state = MediaController.state(context, Any())
                assertTrue(state.getJSONObject("camera").getString("phase") == "off")
                assertTrue(state.getJSONObject("microphone").getString("phase") == "off")
            }
        } finally {
            ActivityLifecycleMonitorRegistry.getInstance().removeLifecycleCallback(observer)
            store.media(cameraAllowed = false, microphoneAllowed = false)
        }
    }

    @Test fun cameraConsentSurvivesRecreation() = consent(true)

    @Test fun microphoneConsentSurvivesRecreation() = consent(false)
}

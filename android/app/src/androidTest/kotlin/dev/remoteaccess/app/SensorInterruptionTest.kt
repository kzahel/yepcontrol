package dev.remoteaccess.app

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.media.AudioManager
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import dev.remoteaccess.app.media.CameraMediaService
import dev.remoteaccess.app.media.MediaController
import dev.remoteaccess.app.media.MicrophoneMediaService
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Real OS contention/mute paths. Instrumentation is not used to qualify background eligibility. */
@RunWith(AndroidJUnit4::class)
class SensorInterruptionTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val owner = Any()
    private val allowed = AtomicBoolean(true)
    private val frames = ConcurrentHashMap<Int, AtomicInteger>()
    private val ended = ConcurrentHashMap<Int, Int>()
    private val contender get() = context.packageName + ".test"

    private fun waitFor(
        message: String,
        predicate: () -> Boolean,
    ) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (predicate()) return
            Thread.sleep(100)
        }
        error(message)
    }

    private fun start(
        camera: Boolean,
        id: Int,
    ) {
        instrumentation.runOnMainSync {
            val (code, request) =
                MediaController.prepare(
                    context,
                    owner,
                    "OS interruption fixture",
                    id,
                    camera,
                    permitted = { allowed.get() },
                    output = { record ->
                        if (record.kind == 4 && record.data[0].toInt() >= 2) {
                            ended[id] = record.data[1].toInt()
                        } else if (record.kind != 4) {
                            frames.computeIfAbsent(id) { AtomicInteger() }.incrementAndGet()
                        }
                        true
                    },
                )
            assertEquals(0, code)
            checkNotNull(request).activate()
        }
    }

    private fun competitor(sensor: String) {
        device.executeShellCommand("run-as $contender rm -f files/sensor-witness.json")
        context.startActivity(
            Intent()
                .setComponent(ComponentName(contender, "dev.remoteaccess.app.SensorCompetitorActivity"))
                .putExtra("sensor", sensor)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        waitFor("Separate-UID contender did not open $sensor") {
            val raw = device.executeShellCommand("run-as $contender cat files/sensor-witness.json").trim()
            runCatching {
                val report = JSONObject(raw)
                report.getString("event") == (if (sensor == "camera") "camera-open" else "microphone-recording") &&
                    !report.getBoolean("silenced")
            }.getOrDefault(false)
        }
    }

    private fun opsStopped(camera: Boolean): Boolean {
        val value = device.executeShellCommand("cmd appops get --user 0 ${context.packageName} ${if (camera) "CAMERA" else "RECORD_AUDIO"}")
        return !value.contains("(running)")
    }

    private fun releaseContender() {
        // Finish its Activity normally so onDestroy releases its own sensor.
        device.pressBack()
        Thread.sleep(300)
    }

    private fun fixture(work: () -> Unit) {
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim(), "Owned emulator only")
        val store = HostStore.get(context).load()
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.CAMERA)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
        instrumentation.uiAutomation.grantRuntimePermission(contender, Manifest.permission.CAMERA)
        instrumentation.uiAutomation.grantRuntimePermission(contender, Manifest.permission.RECORD_AUDIO)
        // Remove the owned target's accessibility privilege for ordinary concurrent-capture policy.
        device.executeShellCommand("settings delete secure enabled_accessibility_services")
        device.executeShellCommand("settings put secure accessibility_enabled 0")
        store.media(cameraAllowed = true, microphoneAllowed = true)
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK,
            ),
        )
        val audio = context.getSystemService(AudioManager::class.java)
        assertFalse(audio.isMicrophoneMute, "Fresh emulator microphone must start unmuted")
        try {
            work()
        } finally {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            try {
                audio.isMicrophoneMute = false
            } finally {
                instrumentation.uiAutomation.dropShellPermissionIdentity()
            }
            allowed.set(false)
            instrumentation.runOnMainSync { MediaController.close(owner) }
            store.media(cameraAllowed = false, microphoneAllowed = false)
            device.executeShellCommand("am force-stop $contender")
            waitFor("Native sensor app-ops remained after cleanup") { opsStopped(true) && opsStopped(false) }
            waitFor("Native sensor foreground services remained after cleanup") {
                var released = false
                instrumentation.runOnMainSync { released = CameraMediaService.current == null && MicrophoneMediaService.current == null }
                released
            }
        }
    }

    @Test fun busyCameraTerminatesWhileMicrophoneContinues() =
        fixture {
            competitor("camera")
            start(false, 2)
            waitFor("Microphone did not begin") { (frames[2]?.get() ?: 0) > 2 }
            start(true, 1)
            waitFor("Contended camera did not terminate") { ended.containsKey(1) }
            assertTrue(ended[1] in listOf(3, 8), "Contention must report busy/interrupted: ${ended[1]}")
            waitFor("Host camera remained running") { opsStopped(true) }
            val before = frames[2]!!.get()
            Thread.sleep(500)
            assertTrue(frames[2]!!.get() > before)
            releaseContender()
            Thread.sleep(500)
            assertFalse(frames.containsKey(1), "Camera must not restart automatically")
        }

    @Test fun microphoneMuteStopsOnlyAudioWithoutRestart() =
        fixture {
            start(true, 1)
            start(false, 2)
            waitFor("Both sensors did not begin") { (frames[1]?.get() ?: 0) > 0 && (frames[2]?.get() ?: 0) > 2 }
            val audio = context.getSystemService(AudioManager::class.java)
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            try {
                audio.isMicrophoneMute = true
            } finally {
                instrumentation.uiAutomation.dropShellPermissionIdentity()
            }
            waitFor("Global microphone mute did not terminate capture") { ended[2] == 1 && opsStopped(false) }
            val before = frames[1]!!.get()
            waitFor("Camera must continue while microphone is muted") { !ended.containsKey(1) && frames[1]!!.get() > before }
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            try {
                audio.isMicrophoneMute = false
            } finally {
                instrumentation.uiAutomation.dropShellPermissionIdentity()
            }
            val audioCount = frames[2]!!.get()
            Thread.sleep(500)
            assertEquals(audioCount, frames[2]!!.get(), "Unmuting must not restart capture")
        }

    @Test fun frameworkSilencingTerminatesAudioWhileCameraContinues() =
        fixture {
            start(true, 1)
            start(false, 2)
            waitFor("Both sensors did not begin") { (frames[1]?.get() ?: 0) > 0 && (frames[2]?.get() ?: 0) > 2 }
            competitor("microphone")
            waitFor("Framework silencing did not terminate microphone") { ended[2] == 3 && opsStopped(false) }
            val before = frames[1]!!.get()
            waitFor("Camera must continue during audio contention") { !ended.containsKey(1) && frames[1]!!.get() > before }
            releaseContender()
            val audioCount = frames[2]!!.get()
            Thread.sleep(500)
            assertEquals(audioCount, frames[2]!!.get(), "Ending contention must not restart capture")
        }
}

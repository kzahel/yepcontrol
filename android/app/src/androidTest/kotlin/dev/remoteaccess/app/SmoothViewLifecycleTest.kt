package dev.remoteaccess.app

import android.app.KeyguardManager
import android.content.Intent
import android.os.SystemClock
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import dev.remoteaccess.app.control.ControlSession
import dev.remoteaccess.app.control.ProjectionConsentActivity
import dev.remoteaccess.app.control.ScreenAccessService
import dev.remoteaccess.app.control.VideoService
import dev.remoteaccess.app.control.VideoStream
import dev.remoteaccess.protocol.CaptureLifecycle.Phase
import dev.remoteaccess.protocol.CaptureLifecycle.Reason
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Real consent, encoder and command lifecycle on a runner-owned emulator; never a physical phone. */
@RunWith(AndroidJUnit4::class)
class SmoothViewLifecycleTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device =
        run {
            Configurator.getInstance().uiAutomationFlags = android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
            UiDevice.getInstance(instrumentation)
        }
    private lateinit var owner: ControlSession
    private val replies = LinkedBlockingQueue<ByteArray>()
    private var sequence = 0
    private var allowed = true
    private var syntheticLock = false
    private val receipt get() = File(context.filesDir, "smooth-view-result.json")

    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)

    private fun waitFor(
        ms: Long = 10000,
        predicate: () -> Boolean,
    ) {
        val end = SystemClock.elapsedRealtime() + ms
        while (SystemClock.elapsedRealtime() < end) {
            if (predicate()) return
            Thread.sleep(80)
        }
        assertTrue(
            predicate(),
            "Native lifecycle condition timed out: ${if (::owner.isInitialized) VideoStream.state(owner) else "setup"}; prompt=${prompt()}",
        )
    }

    private fun prompt() =
        device.hasObject(By.pkg("com.android.systemui")) &&
            (
                device.hasObject(By.res("com.android.systemui:id/screen_share_dialog_title")) ||
                    device.hasObject(By.res("android:id/button1")) ||
                    device.hasObject(By.textContains("Share your screen"))
            )

    private fun click(approve: Boolean) {
        waitFor {
            try {
                val button = device.findObject(By.res(if (approve) "android:id/button1" else "android:id/button2"))
                if (button == null) {
                    false
                } else {
                    button.click()
                    true
                }
            } catch (_: StaleObjectException) {
                false
            }
        }
    }

    private fun newOwner() {
        owner = ControlSession(context, "smooth-view-fixture", { allowed }, { replies.offer(it.copyOf()) })
    }

    private fun command(
        op: Int,
        value: Int? = null,
    ): ByteArray {
        val input =
            ByteBuffer
                .allocate(if (value == null) 12 else 13)
                .putInt(0x41524331)
                .put(op.toByte())
                .put(byteArrayOf(0, 0, 0))
                .putInt(++sequence)
                .apply { if (value != null) put(value.toByte()) }
                .array()
        owner.receive(input)
        return assertNotNull(replies.poll(10, TimeUnit.SECONDS), "Missing command reply")
    }

    private fun start() {
        assertEquals(0, command(16, 2).last().toInt())
        waitFor { prompt() }
        assertEquals(Phase.CONSENT, VideoStream.request?.lifecycle?.phase)
    }

    private fun stop() {
        assertEquals(0, command(16, 0).last().toInt())
        assertOff()
    }

    private fun assertOff() {
        waitFor { VideoStream.request == null && !prompt() }
        assertEquals("off", VideoStream.state(owner).getString("phase"))
        assertFalse(device.executeShellCommand("dumpsys media_projection").contains("TYPE_SCREEN_CAPTURE"))
    }

    private fun frames() {
        waitFor { VideoStream.request?.poll() != null }
        assertTrue(VideoStream.available(context, owner))
    }

    private fun retry() {
        // The system dialog clips action buttons in landscape on these emulator images.
        device.setOrientationNatural()
        start()
        click(true)
        frames()
        stop()
    }

    private fun mark(
        stage: String,
        skipped: Boolean = false,
    ) {
        receipt.writeText(
            JSONObject()
                .put("stage", stage)
                .put("sdk", android.os.Build.VERSION.SDK_INT)
                .put("video", VideoStream.state(owner))
                .put("prompt", prompt())
                .put("skipped", skipped)
                .toString(),
        )
    }

    private fun locked() = context.getSystemService(KeyguardManager::class.java).isKeyguardLocked

    private fun setSyntheticLock() {
        File(context.filesDir, "smooth-view-synthetic-lock").writeText("owned-emulator")
        assertTrue(device.executeShellCommand("locksettings set-pin 314159").contains("Pin set"))
        syntheticLock = true
    }

    private fun unlockFixture() {
        device.executeShellCommand("locksettings clear --old 314159")
        syntheticLock = false
        File(context.filesDir, "smooth-view-synthetic-lock").delete()
        device.wakeUp()
        device.executeShellCommand("wm dismiss-keyguard")
        waitFor { !locked() }
    }

    @Test fun lifecycle() {
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim(), "Owned emulator only")
        val scenario = assertNotNull(InstrumentationRegistry.getArguments().getString("scenario"))
        device.wakeUp()
        device.setOrientationNatural()
        receipt.delete()
        File(context.filesDir, "smooth-view-failure.png").delete()
        File(context.filesDir, "smooth-view-failure.xml").delete()
        // Rebind after first instrumentation attachment if the fresh app has not bound yet.
        device.executeShellCommand("settings delete secure enabled_accessibility_services")
        device.executeShellCommand(
            "settings put secure enabled_accessibility_services com.yepcontrol.app/dev.remoteaccess.app.control.ScreenAccessService",
        )
        device.executeShellCommand("settings put secure accessibility_enabled 1")
        waitFor(20000) { ScreenAccessService.current != null }
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        HostSessions.current.set(HostSessions.Lease("smooth-view-fixture", "fixture"))
        newOwner()
        try {
            when (scenario) {
                "cancel", "back" -> {
                    start()
                    if (scenario == "back") device.pressBack() else click(false)
                    assertOff()
                    assertEquals("canceled", VideoStream.state(owner).getString("reason"))
                    Thread.sleep(500)
                    assertFalse(prompt())
                    retry()
                }
                "pending-off" -> {
                    start()
                    stop()
                    retry()
                }
                "rapid-toggle" -> {
                    start()
                    val old = assertNotNull(VideoStream.request)
                    assertEquals(0, command(16, 0).last().toInt())
                    start()
                    assertTrue(old !== VideoStream.request)
                    click(true)
                    frames()
                    // A late completion from the old dialog cannot stop the new stream.
                    main { VideoStream.end(context, old, Reason.CANCELED) }
                    frames()
                    Thread.sleep(300)
                    assertFalse(prompt(), "Only one consent dialog may survive")
                    stop()
                }
                "stale-service" -> {
                    start()
                    val oldId = assertNotNull(VideoStream.request).id
                    stop()
                    start()
                    val next = VideoStream.request
                    context.startService(
                        Intent(context, VideoService::class.java)
                            .putExtra("request", oldId)
                            .putExtra("consent", Intent()),
                    )
                    Thread.sleep(500)
                    assertTrue(next === VideoStream.request)
                    assertEquals(Phase.CONSENT, next?.lifecycle?.phase)
                    assertTrue(prompt())
                    click(true)
                    frames()
                    stop()
                }
                "rotation" -> {
                    start()
                    val original = VideoStream.request
                    device.setOrientationLeft()
                    waitFor { prompt() }
                    assertTrue(original === VideoStream.request)
                    // SystemUI can clip the buttons in landscape; restoring portrait must not
                    // replace the request or require a second start command.
                    device.setOrientationNatural()
                    assertTrue(original === VideoStream.request)
                    click(true)
                    frames()
                    stop()
                    retry()
                }
                "recreate" -> {
                    start()
                    val activity = assertNotNull(VideoStream.request?.activity)
                    main { activity.recreate() }
                    assertOff()
                    assertEquals("interrupted", VideoStream.state(owner).getString("reason"))
                    retry()
                }
                "timeout" -> {
                    start()
                    val original = VideoStream.request
                    assertEquals(0, command(16, 3).last().toInt())
                    assertTrue(original === VideoStream.request)
                    assertOffAfterTimeout()
                    retry()
                }
                "active" -> {
                    start()
                    click(true)
                    frames()
                    device.setOrientationLeft()
                    frames()
                    for (quality in listOf(1, 3, 2)) {
                        assertEquals(0, command(16, quality).last().toInt())
                        frames()
                        assertFalse(prompt())
                    }
                    stop()
                    retry()
                }
                "owner", "policy" -> {
                    start()
                    if (scenario == "owner") owner.close() else allowed = false
                    assertOff()
                }
                "owner-active", "policy-active" -> {
                    start()
                    click(true)
                    frames()
                    if (scenario == "owner-active") owner.close() else allowed = false
                    assertOff()
                    allowed = true
                    newOwner()
                    retry()
                }
                "lock", "lock-pending" -> {
                    setSyntheticLock()
                    start()
                    if (scenario == "lock") {
                        click(true)
                        frames()
                    }
                    device.sleep()
                    waitFor { locked() }
                    // Stop is idempotent even before lock-triggered teardown has finished.
                    assertEquals(0, command(16, 0).last().toInt())
                    waitFor { VideoStream.request == null }
                    unlockFixture()
                    assertOff()
                    retry()
                }
                "permission", "permission-pending" -> {
                    start()
                    if (scenario == "permission") {
                        click(true)
                        frames()
                    }
                    device.executeShellCommand("settings delete secure enabled_accessibility_services")
                    waitFor { ScreenAccessService.current == null }
                    assertOff()
                    // No accessibility service is required to accept an already-stopped Off.
                    assertEquals(0, command(16, 0).last().toInt())
                }
                "system-stop" -> {
                    start()
                    click(true)
                    frames()
                    val chip = device.findObject(By.desc("Sharing screen"))
                    if (chip == null) {
                        mark("complete", skipped = true)
                        return
                    }
                    chip.click()
                    val button = device.findObject(By.text(Pattern.compile("Stop sharing|Stop|STOP")))
                    assertNotNull(button).click()
                    assertOff()
                    retry()
                }
                "remote-consent" -> {
                    start()
                    Thread.sleep(300)
                    val bounds = assertNotNull(device.findObject(By.res("android:id/button1"))).visibleBounds
                    val image = command(3)
                    assertEquals(3, image[4].toInt())
                    val scene = ByteBuffer.wrap(image).getInt(12)
                    val tap =
                        ByteBuffer
                            .allocate(24)
                            .putInt(0x41524331)
                            .put(4.toByte())
                            .put(byteArrayOf(0, 0, 0))
                            .putInt(++sequence)
                            .putInt(scene)
                            .putInt(bounds.centerX())
                            .putInt(bounds.centerY())
                            .array()
                    owner.receive(tap)
                    assertEquals(0, assertNotNull(replies.poll(10, TimeUnit.SECONDS)).last().toInt())
                    frames()
                    stop()
                }
                "browser" -> browserCommands()
                "kill-pending", "kill-active" -> {
                    start()
                    if (scenario == "kill-active") {
                        click(true)
                        frames()
                    }
                    mark("ready-for-kill")
                    Thread.sleep(60000) // Runner kills only its owned host and verifies projection cleanup.
                    error("Runner did not terminate the prepared process")
                }
                else -> error("Unknown lifecycle scenario")
            }
            mark("complete")
        } catch (failure: Throwable) {
            device.takeScreenshot(File(context.filesDir, "smooth-view-failure.png"))
            device.dumpWindowHierarchy(File(context.filesDir, "smooth-view-failure.xml"))
            throw failure
        } finally {
            owner.close()
            main {
                VideoStream.close(context)
                val monitor = ActivityLifecycleMonitorRegistry.getInstance()
                Stage.entries
                    .flatMap { monitor.getActivitiesInStage(it) }
                    .filterIsInstance<ProjectionConsentActivity>()
                    .filter { !it.isDestroyed }
                    .forEach { it.dismiss() }
            }
            if (syntheticLock) unlockFixture()
            device.unfreezeRotation()
            HostSessions.current.set(null)
        }
    }

    private fun browserCommands() {
        val command = File(context.filesDir, "smooth-view-command")
        val reply = File(context.filesDir, "smooth-view-reply")
        command.delete()
        reply.delete()
        mark("browser-ready")
        val deadline = SystemClock.elapsedRealtime() + 120000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (!command.exists()) {
                Thread.sleep(5)
                continue
            }
            val request = JSONObject(command.readText())
            command.delete()
            val response = JSONObject().put("id", request.getInt("id"))
            when (request.optString("action")) {
                "approve" -> click(true)
                "cancel" -> click(false)
                "inspect" -> response.put("video", VideoStream.state(owner)).put("prompt", prompt())
                "finish" -> {
                    assertOff()
                    return
                }
                else -> {
                    owner.receive(Base64.decode(request.getString("payload"), Base64.NO_WRAP))
                    response.put("payload", Base64.encodeToString(assertNotNull(replies.poll(10, TimeUnit.SECONDS)), Base64.NO_WRAP))
                }
            }
            val next = File(context.filesDir, "smooth-view-reply.next")
            next.writeText(response.toString())
            assertTrue(next.renameTo(reply))
        }
        error("Browser fixture timed out")
    }

    private fun assertOffAfterTimeout() {
        waitFor(65000) { VideoStream.request == null && !prompt() }
        assertOff()
        assertEquals("timeout", VideoStream.state(owner).getString("reason"))
    }
}

package dev.remoteaccess.app.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.graphics.scale
import dev.remoteaccess.app.unlock.PinUnlock
import dev.remoteaccess.app.unlock.PinVault
import dev.remoteaccess.protocol.ControlCommand
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Android primitives only; all authority, sequencing and sockets stay in ControlSession. */
class ScreenAccessService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private val compression = Executors.newSingleThreadExecutor()
    private val capturing = AtomicBoolean(false)

    @Volatile private var scene = 1
    private var window = -1
    private var rotation = -1
    private var gesture = false
    private val touch = TouchController(this, main)
    private val unlock = PinUnlock(this, main)

    internal val inputInFlight get() = gesture || touch.dispatching

    internal fun settingsChanged() {
        invalidate()
        if (LocalSettingsProtection.hideCapture) VideoStream.close(this)
    }

    @Volatile private var capturedAt = 0L

    @Volatile private var screenWidth = 0

    @Volatile private var screenHeight = 0

    override fun onServiceConnected() {
        current = this
        dev.remoteaccess.app.HostStore
            .get(this)
            .listeners
            .forEach { it() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        unlock.observeUnlocked()
        val next = rootInActiveWindow?.windowId ?: -1
        val display = getSystemService(android.hardware.display.DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        val nextRotation = display?.rotation ?: -1
        if (next != window || nextRotation != rotation) {
            window = next
            rotation = nextRotation
            invalidate()
        }
    }

    private fun invalidate() {
        touch.release()
        scene = if (scene == Int.MAX_VALUE) 1 else scene + 1
        capturedAt = 0
    }

    override fun onInterrupt() {
        invalidate()
    }

    override fun onUnbind(intent: Intent): Boolean {
        if (current === this) current = null
        dev.remoteaccess.app.HostStore
            .get(this)
            .listeners
            .forEach { it() }
        invalidate()
        VideoStream.close(this, reason = dev.remoteaccess.protocol.CaptureLifecycle.Reason.PERMISSION)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (current === this) current = null
        dev.remoteaccess.app.HostStore
            .get(this)
            .listeners
            .forEach { it() }
        invalidate()
        VideoStream.close(this, reason = dev.remoteaccess.protocol.CaptureLifecycle.Reason.PERMISSION)
        compression.shutdownNow()
        super.onDestroy()
    }

    private fun locked() = getSystemService(KeyguardManager::class.java).isKeyguardLocked

    internal fun videoGeometry(
        width: Int,
        height: Int,
    ): Int {
        if (locked()) return scene
        screenWidth = width
        screenHeight = height
        capturedAt = android.os.SystemClock.elapsedRealtime()
        return scene
    }

    fun state(): JSONObject =
        JSONObject()
            .put("type", "state")
            .put("v", 1)
            .put("accessibility", true)
            .put(
                "locked",
                locked(),
            ).put("width", screenWidth)
            .put("height", screenHeight)
            .put("scene", scene)
            .put("videoActive", VideoStream.available(this))
            .put("localSettings", LocalSettingsProtection.blocked)

    fun execute(
        command: ControlCommand,
        owner: Any,
        allowed: () -> Boolean,
        reply: (Int, ByteArray) -> Unit,
    ) {
        val inputRevision = LocalSettingsProtection.revision
        val input = command.op in listOf(4, 5, 7, 8, 11, 13, 14) || (command.op == 6 && command.values[0] == 3)
        val inputAllowed = {
            allowed() && (!input || (!LocalSettingsProtection.blocked && inputRevision == LocalSettingsProtection.revision))
        }
        main.post {
            fun result(code: Int) = reply(2, byteArrayOf(code.toByte()))
            if (!allowed() || current !== this) return@post result(8)
            if (!inputAllowed()) return@post result(4)
            if (command.op == 2) return@post reply(1, state().toString().toByteArray())
            if (command.op == 9) {
                unlock.wake()
                return@post result(0)
            }
            if (command.op == 16) {
                if (command.values[0] != 0 && locked()) return@post result(3)
                return@post result(if (VideoStream.configure(this, owner, allowed, command.values[0])) 0 else 4)
            }
            if (command.op == 18) {
                VideoStream.request?.takeIf { it.owner === owner }?.let {
                    it.reset()
                }
                return@post result(0)
            }
            if (command.op == 17) {
                val stream = VideoStream.request
                if (locked() || stream == null || stream.owner !== owner || !VideoStream.available(this)) return@post result(4)
                val frame = stream.poll()
                return@post if (frame == null) result(6) else reply(5, frame)
            }
            if (command.op == 13 || command.op == 14) {
                invalidate()
                val pin =
                    try {
                        if (command.op == 14) PinVault(this).read() else command.text.toCharArray()
                    } catch (_: Exception) {
                        return@post result(4)
                    }
                unlock.attempt(pin, inputAllowed, ::result)
                return@post
            }
            if (unlock.active) return@post result(6)
            if (command.op == 15) {
                invalidate()
                return@post result(if (performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)) 0 else 4)
            }
            if (command.op == 12) {
                touch.release(owner)
                return@post result(0)
            }
            if (locked()) return@post result(3)
            if (command.op == 11) {
                val batch = checkNotNull(command.touch)
                if (!touch.active && (capturedAt == 0L || android.os.SystemClock.elapsedRealtime() - capturedAt > 10000)) {
                    return@post result(2)
                }
                touch.accept(batch, owner, screenWidth, screenHeight, scene, inputAllowed, ::result)
                return@post
            }
            if (command.op == 3) return@post capture(allowed, reply)
            if (locked()) return@post result(3)
            when (command.op) {
                4, 5 -> {
                    val v = command.values
                    if (v[0] != scene || android.os.SystemClock.elapsedRealtime() - capturedAt > 10000 || capturedAt == 0L) {
                        return@post result(2)
                    }
                    val points = if (command.op == 4) listOf(v[1] to v[2]) else listOf(v[1] to v[2], v[3] to v[4])
                    if (points.any { it.first !in 0 until screenWidth || it.second !in 0 until screenHeight }) return@post result(2)
                    if (gesture || touch.active) return@post result(6)
                    val path =
                        Path().apply {
                            moveTo(v[1].toFloat(), v[2].toFloat())
                            if (command.op == 5) lineTo(v[3].toFloat(), v[4].toFloat())
                        }
                    invalidate()
                    gesture = true
                    val accepted =
                        dispatchGesture(
                            GestureDescription
                                .Builder()
                                .addStroke(
                                    GestureDescription.StrokeDescription(path, 0, if (command.op == 4) 50 else v[5].toLong()),
                                ).build(),
                            object : GestureResultCallback() {
                                override fun onCompleted(gestureDescription: GestureDescription) {
                                    gesture = false
                                    result(if (allowed()) 0 else 8)
                                }

                                override fun onCancelled(gestureDescription: GestureDescription) {
                                    gesture = false
                                    result(7)
                                }
                            },
                            main,
                        )
                    if (!accepted) {
                        gesture = false
                        result(7)
                    }
                }
                6 -> {
                    invalidate()
                    result(
                        if (performGlobalAction(
                                listOf(GLOBAL_ACTION_BACK, GLOBAL_ACTION_HOME, GLOBAL_ACTION_RECENTS)[command.values[0] - 1],
                            )
                        ) {
                            0
                        } else {
                            4
                        },
                    )
                }
                7 -> {
                    val focus = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                    if (focus == null || !focus.isEditable) return@post result(4)
                    invalidate()
                    result(
                        if (focus.performAction(
                                AccessibilityNodeInfo.ACTION_SET_TEXT,
                                Bundle().apply {
                                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, command.text)
                                },
                            )
                        ) {
                            0
                        } else {
                            4
                        },
                    )
                }
                8 -> {
                    val intent = packageManager.getLaunchIntentForPackage(command.text) ?: return@post result(4)
                    invalidate()
                    try {
                        startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        result(0)
                    } catch (_: Exception) {
                        result(4)
                    }
                }
                else -> result(4)
            }
        }
    }

    fun release(owner: Any) {
        main.post {
            touch.release(owner)
            VideoStream.close(this, owner)
        }
    }

    private fun capture(
        allowed: () -> Boolean,
        reply: (Int, ByteArray) -> Unit,
    ) {
        if (LocalSettingsProtection.hideCapture) {
            reply(2, byteArrayOf(4))
            return
        }
        if (!capturing.compareAndSet(false, true)) {
            reply(2, byteArrayOf(6))
            return
        }
        val expected = scene
        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            main::post,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    val buffer = screenshot.hardwareBuffer
                    compression.execute {
                        var bitmap: Bitmap? = null
                        var scaled: Bitmap? = null
                        try {
                            bitmap = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)?.copy(Bitmap.Config.ARGB_8888, false)
                            val image = checkNotNull(bitmap)
                            val width = image.width
                            val height = image.height
                            val factor = minOf(1.0, 720.0 / minOf(width, height))
                            scaled =
                                image.scale(
                                    (width * factor).toInt().coerceAtLeast(1),
                                    (height * factor).toInt().coerceAtLeast(1),
                                    true,
                                )
                            val output = ByteArrayOutputStream()
                            check(scaled.compress(Bitmap.CompressFormat.JPEG, 65, output))
                            val bytes = output.toByteArray()
                            main.post {
                                capturing.set(false)
                                if (!allowed() || LocalSettingsProtection.hideCapture || current !== this@ScreenAccessService) {
                                    reply(2, byteArrayOf(8))
                                } else if (locked() || expected != scene || bytes.size > 1048540) {
                                    reply(2, byteArrayOf(5))
                                } else {
                                    screenWidth = width
                                    screenHeight = height
                                    capturedAt = android.os.SystemClock.elapsedRealtime()
                                    reply(
                                        3,
                                        ByteBuffer
                                            .allocate(12 + bytes.size)
                                            .putInt(scene)
                                            .putInt(width)
                                            .putInt(height)
                                            .put(bytes)
                                            .array(),
                                    )
                                }
                            }
                        } catch (
                            _: Exception,
                        ) {
                            main.post {
                                capturing.set(false)
                                invalidate()
                                reply(2, byteArrayOf(5))
                            }
                        } finally {
                            scaled?.let { if (it !== bitmap) it.recycle() }
                            bitmap?.recycle()
                            buffer.close()
                        }
                    }
                }

                override fun onFailure(errorCode: Int) {
                    capturing.set(false)
                    invalidate()
                    reply(2, byteArrayOf(5))
                }
            },
        )
    }

    companion object {
        @Volatile var current: ScreenAccessService? = null
            private set
    }
}

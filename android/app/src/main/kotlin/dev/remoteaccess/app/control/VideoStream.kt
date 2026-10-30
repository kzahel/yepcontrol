package dev.remoteaccess.app.control

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import dev.remoteaccess.app.HostSessions
import dev.remoteaccess.protocol.CaptureLifecycle
import dev.remoteaccess.protocol.CaptureLifecycle.Phase
import dev.remoteaccess.protocol.CaptureLifecycle.Reason
import dev.remoteaccess.protocol.VideoQueue
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicInteger

/** One session owns the projection and a bounded mailbox. Dropping a frame requires a new keyframe. */
internal object VideoStream {
    class Request(
        val owner: Any,
        val allowed: () -> Boolean,
        @Volatile var quality: Int,
    ) {
        val lifecycle = CaptureLifecycle(ids.updateAndGet { if (it == Int.MAX_VALUE) 1 else it + 1 }, SystemClock.elapsedRealtime())
        val id get() = lifecycle.id
        val active get() = lifecycle.phase == Phase.ACTIVE
        var activity: ProjectionConsentActivity? = null

        val frames = VideoQueue()

        @Volatile var keyframe = true

        @Volatile var width = 0

        @Volatile var height = 0
        private var generation = epochs.incrementAndGet()

        @Synchronized fun reset() {
            frames.reset()
            generation = epochs.incrementAndGet()
            keyframe = true
        }

        @Synchronized fun offer(
            data: ByteArray,
            key: Boolean,
            timestamp: Long,
            w: Int,
            h: Int,
        ) {
            if (!allowed() || LocalSettingsProtection.hideCapture || request !== this || lifecycle.phase == Phase.OFF) return
            if (data.size > 524200) {
                reset()
                return
            }
            val geometry = ScreenAccessService.current?.videoGeometry(w, h) ?: return
            val packet =
                ByteBuffer
                    .allocate(36 + data.size)
                    .putInt(generation)
                    .putInt(geometry)
                    .putInt(width)
                    .putInt(height)
                    .putInt(w)
                    .putInt(h)
                    .putInt(if (key) 1 else 0)
                    .putLong(timestamp)
                    .put(data)
                    .array()
            if (!frames.offer(packet, key)) {
                keyframe = true
            } else if (!lifecycle.frame(SystemClock.elapsedRealtime())) {
                frames.reset()
            }
        }

        @Synchronized fun poll(): ByteArray? {
            if (!allowed() || LocalSettingsProtection.hideCapture || !active) return null
            return frames.poll()
        }
    }

    private val epochs = AtomicInteger()
    private val ids = AtomicInteger()
    private val main = Handler(Looper.getMainLooper())

    // Values contain no owner references; ended sessions do not stay resident.
    private val states = WeakHashMap<Any, CaptureLifecycle.Snapshot>()

    @Volatile var request: Request? = null
        private set

    fun configure(
        context: Context,
        owner: Any,
        allowed: () -> Boolean,
        quality: Int,
    ): Boolean {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (quality == 0) {
            close(context, owner)
            return true
        }
        val old = request
        if (old?.owner === owner && old.allowed() && old.lifecycle.phase != Phase.OFF) {
            old.quality = quality
            return true
        }
        close(context)
        if (!allowed() || LocalSettingsProtection.hideCapture) return false
        val next = Request(owner, allowed, quality)
        request = next
        try {
            context.startActivity(
                Intent(context, ProjectionConsentActivity::class.java)
                    .putExtra("request", next.id)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            watch(context.applicationContext, next)
        } catch (_: Exception) {
            end(context, next, Reason.UNAVAILABLE)
            return false
        }
        return true
    }

    private fun watch(
        context: Context,
        stream: Request,
    ) {
        main.postDelayed({
            if (request !== stream) return@postDelayed
            val why =
                when {
                    !stream.allowed() -> Reason.PERMISSION
                    context.getSystemService(KeyguardManager::class.java).isKeyguardLocked -> Reason.LOCKED
                    stream.lifecycle.expire(SystemClock.elapsedRealtime()) -> stream.lifecycle.reason
                    else -> null
                }
            if (why != null) end(context, stream, why) else watch(context, stream)
        }, 200)
    }

    fun close(
        context: Context,
        owner: Any? = null,
        reason: Reason = Reason.STOPPED,
    ) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { close(context, owner, reason) }
            return
        }
        val old = request ?: return
        if (owner != null && old.owner !== owner) return
        end(context, old, reason)
    }

    /** Every asynchronous completion must name its exact request, including service dispatch. */
    fun end(
        context: Context,
        stream: Request?,
        reason: Reason,
    ) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (stream == null || request !== stream) return
        request = null
        stream.lifecycle.stop(reason)
        stream.frames.reset()
        synchronized(states) { states[stream.owner] = stream.lifecycle.snapshot() }
        val activity = stream.activity
        stream.activity = null
        activity?.dismiss()
        context.stopService(Intent(context, VideoService::class.java))
    }

    fun approve(
        context: Context,
        stream: Request,
        consent: Intent,
    ) {
        if (request !== stream || stream.lifecycle.phase !in listOf(Phase.CONSENT, Phase.OFF)) return
        val failure =
            when {
                !stream.allowed() -> Reason.PERMISSION
                context.getSystemService(KeyguardManager::class.java).isKeyguardLocked -> Reason.LOCKED
                !stream.lifecycle.approved(SystemClock.elapsedRealtime()) -> stream.lifecycle.reason
                else -> null
            }
        if (failure != null) {
            end(context, stream, failure)
            return
        }
        stream.activity = null
        try {
            // Consent returns to a visible activity. Promote only after validating the request
            // in the service; a canceled dispatch must not leave an unfulfilled FGS deadline.
            context.startService(
                Intent(context, VideoService::class.java).putExtra("consent", consent).putExtra("request", stream.id),
            )
        } catch (_: Exception) {
            end(context, stream, Reason.UNAVAILABLE)
        }
    }

    fun available(
        context: Context,
        owner: Any? = null,
    ) = request?.let {
        (owner == null || it.owner === owner) &&
            it.allowed() &&
            it.active &&
            !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
    } == true

    fun state(owner: Any): JSONObject {
        val current = request?.takeIf { it.owner === owner }
        val snapshot = current?.lifecycle?.snapshot() ?: synchronized(states) { states[owner] }
        return JSONObject()
            .put("id", snapshot?.id ?: 0)
            .put("phase", snapshot?.phase?.wire ?: "off")
            .put("reason", snapshot?.reason?.wire ?: "none")
    }
}

/** Fresh system consent per request. Recreation cancels cleanly; no token is retained or reused. */
class ProjectionConsentActivity : Activity() {
    private var pending: VideoStream.Request? = null

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val stream = VideoStream.request?.takeIf { it.id == intent.getIntExtra("request", 0) }
        pending = stream
        if (savedInstanceState != null || stream == null || !stream.allowed() || HostSessions.current.get() == null) {
            VideoStream.end(this, stream, Reason.INTERRUPTED)
            dismiss()
            return
        }
        stream.activity = this
        val manager = getSystemService(MediaProjectionManager::class.java)
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(
                if (android.os.Build.VERSION.SDK_INT >= 34) {
                    manager.createScreenCaptureIntent(
                        android.media.projection.MediaProjectionConfig
                            .createConfigForDefaultDisplay(),
                    )
                } else {
                    manager.createScreenCaptureIntent()
                },
                41,
            )
        } catch (_: Exception) {
            VideoStream.end(this, stream, Reason.UNAVAILABLE)
            dismiss()
        }
    }

    internal fun dismiss() {
        if (isDestroyed) return
        finishActivity(41)
        finish()
    }

    @Deprecated("Activity result API is retained for this single ephemeral consent activity")
    override fun onActivityResult(
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
    ) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 41) return
        val stream = pending
        pending = null
        if (stream != null) {
            if (resultCode == RESULT_OK && data != null) {
                VideoStream.approve(this, stream, data)
            } else {
                VideoStream.end(this, stream, Reason.CANCELED)
            }
        }
        finish()
    }

    override fun onDestroy() {
        val stream = pending
        if (stream?.activity === this) {
            stream.activity = null
            VideoStream.end(this, stream, Reason.INTERRUPTED)
        }
        super.onDestroy()
    }
}

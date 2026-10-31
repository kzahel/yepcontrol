package dev.remoteaccess.app.media

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import dev.remoteaccess.app.HostStore
import dev.remoteaccess.protocol.MediaRecord
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** Sensor ownership is independent from the display, projection consent and keyguard. */
internal object MediaController {
    val main = Handler(Looper.getMainLooper())
    private val requests = mutableListOf<Request>() // Main-thread only, including reservations being released.

    class Request(
        val context: Context,
        val owner: Any,
        val label: String,
        val id: Int,
        val camera: Boolean,
        val facing: Int,
        val format: Int,
        val fps: Int,
        val permitted: () -> Boolean,
        private val output: (MediaRecord) -> Boolean,
    ) {
        val active = AtomicBoolean(true)

        @Volatile var phase = "starting"

        @Volatile var reason = 0

        @Volatile var deadline = SystemClock.elapsedRealtime() + MediaRecord.LEASE_MS
        private val started = SystemClock.elapsedRealtime()
        private var sequence = 0L

        @Volatile private var delivered = false
        private var activated = false
        private val check =
            object : Runnable {
                override fun run() {
                    if (!active.get()) return
                    val why = invalid()
                    if (why != 0) end(this@Request, why) else main.postDelayed(this, 250)
                }
            }

        fun invalid(): Int =
            when {
                !permitted() -> 5
                !allowed(context, camera) -> 2
                !permission(context, camera) -> 1
                SystemClock.elapsedRealtime() >= deadline -> 6
                !delivered && SystemClock.elapsedRealtime() - started >= MediaRecord.START_MS -> 6
                else -> 0
            }

        /** Called only after the command acknowledgement; startup cannot overtake it. */
        fun activate() {
            checkMain()
            if (activated || !active.get()) return
            activated = true
            if (!emit(4, byteArrayOf(1, 0))) {
                end(this, 8)
                return
            }
            main.post(check)
            try {
                context.startForegroundService(Intent(context, service(camera)).putExtra("stream", id))
            } catch (_: SecurityException) {
                end(this, 1)
            } catch (_: Exception) {
                end(this, 4)
            }
        }

        @Synchronized fun offer(
            kind: Int,
            data: ByteArray,
            width: Int,
            height: Int,
            key: Boolean = false,
        ): Boolean {
            if (!active.get()) return false
            val why = invalid()
            if (why != 0) {
                main.post { end(this, why) }
                return false
            }
            if (!emit(kind, data, width, height, key)) {
                main.post { end(this, 8) }
                return false
            }
            delivered = true
            phase = "live"
            return true
        }

        @Synchronized private fun emit(
            kind: Int,
            data: ByteArray,
            width: Int = 0,
            height: Int = 0,
            key: Boolean = false,
        ): Boolean {
            if (sequence >= 0xffffffffL) return false
            return runCatching {
                output(MediaRecord(kind, id, ++sequence, SystemClock.elapsedRealtimeNanos() / 1000, width, height, key, data))
            }.getOrDefault(false)
        }

        fun released() {
            checkMain()
            if (!requests.remove(this)) return
            main.removeCallbacks(check)
            phase = "off"
            emit(4, byteArrayOf(if (reason == 7) 2 else 3, reason.toByte()))
            updateNotifications()
        }
    }

    fun checkMain() = check(Looper.myLooper() == Looper.getMainLooper())

    fun service(camera: Boolean) = if (camera) CameraMediaService::class.java else MicrophoneMediaService::class.java

    fun permission(
        context: Context,
        camera: Boolean,
    ) = context.checkSelfPermission(
        if (camera) Manifest.permission.CAMERA else Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED

    fun allowed(
        context: Context,
        camera: Boolean,
    ): Boolean =
        HostStore.get(context).snapshot.settings.let {
            if (camera) it.cameraAllowed else it.microphoneAllowed
        }

    fun cameras(context: Context): Map<Int, String> =
        runCatching {
            val manager = context.getSystemService(CameraManager::class.java)
            manager.cameraIdList
                .mapNotNull { id ->
                    when (manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING)) {
                        CameraCharacteristics.LENS_FACING_BACK -> 1 to id
                        CameraCharacteristics.LENS_FACING_FRONT -> 2 to id
                        else -> null
                    }
                }.fold(linkedMapOf<Int, String>()) { result, (facing, id) -> result.apply { putIfAbsent(facing, id) } }
        }.getOrDefault(emptyMap())

    /** Reserve on main. Rejection emits no packets. Caller owns the bounded consumed-ID set. */
    fun prepare(
        context: Context,
        owner: Any,
        label: String,
        id: Int,
        camera: Boolean,
        facing: Int = 1,
        format: Int = 1,
        fps: Int = 1,
        permitted: () -> Boolean,
        output: (MediaRecord) -> Boolean,
    ): Pair<Int, Request?> {
        checkMain()
        require(id > 0 && facing in 1..2 && format in 1..2 && fps in 1..if (format == 1) 5 else 30)
        val code =
            when {
                !permitted() -> 8
                !allowed(context, camera) -> 11
                !permission(context, camera) -> 10
                requests.any { it.owner === owner && it.id == id } -> 4
                requests.any { it.camera == camera } -> 6
                camera && !cameras(context).containsKey(facing) -> 4
                !camera && !context.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE) -> 4
                else -> 0
            }
        if (code != 0) return code to null
        val request = Request(context.applicationContext, owner, label.take(80), id, camera, facing, format, fps, permitted, output)
        requests.add(request)
        return 0 to request
    }

    fun pending(
        camera: Boolean,
        id: Int,
    ): Request? {
        checkMain()
        return requests.firstOrNull { it.camera == camera && it.id == id && it.active.get() }
    }

    fun renew(
        owner: Any,
        id: Int,
    ): Boolean {
        checkMain()
        val request = requests.firstOrNull { it.owner === owner && it.id == id && it.active.get() } ?: return false
        val why = request.invalid()
        if (why != 0) {
            end(request, why)
            return false
        }
        request.deadline = SystemClock.elapsedRealtime() + MediaRecord.LEASE_MS
        return true
    }

    fun close(
        owner: Any? = null,
        id: Int = 0,
        reason: Int = 7,
    ) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { close(owner, id, reason) }
            return
        }
        requests.toList().filter { (owner == null || it.owner === owner) && (id == 0 || it.id == id) }.forEach { end(it, reason) }
    }

    fun end(
        request: Request,
        reason: Int,
    ) {
        checkMain()
        if (!request.active.compareAndSet(true, false)) return
        request.reason = reason
        // Services acknowledge release after closing native resources. A not-yet-delivered
        // start intent is harmless: pending() excludes this canceled generation.
        val running = if (request.camera) CameraMediaService.current else MicrophoneMediaService.current
        if (running?.request === request) {
            running.finish()
        } else {
            request.context.stopService(Intent(request.context, service(request.camera)))
            request.released()
        }
    }

    fun state(
        context: Context,
        owner: Any,
    ): JSONObject {
        checkMain()
        val cameras = cameras(context)

        fun sensor(camera: Boolean): JSONObject {
            val request = requests.firstOrNull { it.owner === owner && it.camera == camera && it.active.get() }
            return JSONObject()
                .put(
                    "available",
                    if (camera) cameras.isNotEmpty() else context.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE),
                ).put("allowed", allowed(context, camera))
                .put("permission", permission(context, camera))
                .put("stream", request?.id ?: 0)
                .put("phase", request?.phase ?: "off")
                .put("reason", "none")
        }
        return JSONObject()
            .put("v", 1)
            .put("camera", sensor(true).put("front", cameras.containsKey(2)).put("rear", cameras.containsKey(1)))
            .put("microphone", sensor(false))
    }

    fun labels(): String = requests.filter { it.active.get() }.joinToString(" · ") { if (it.camera) "Camera" else "Microphone" }

    fun updateNotifications() {
        CameraMediaService.current?.notification()
        MicrophoneMediaService.current?.notification()
    }
}

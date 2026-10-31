package dev.remoteaccess.app.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.camera2.CameraAccessException
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import dev.remoteaccess.app.MainActivity
import java.util.concurrent.atomic.AtomicBoolean

/** Separate service instances prevent one sensor from requiring the other's permission. */
internal abstract class SensorMediaService(
    private val camera: Boolean,
) : Service() {
    internal var request: MediaController.Request? = null
        private set
    private val finishing = AtomicBoolean(false)
    private var destroyed = false
    private var closed = false
    private lateinit var worker: HandlerThread
    protected lateinit var handler: Handler
    private val notificationId get() = if (camera) 104 else 105

    override fun onCreate() {
        super.onCreate()
        worker = HandlerThread(if (camera) "remote-camera" else "remote-microphone").apply { start() }
        handler = Handler(worker.looper)
        if (camera) CameraMediaService.current = this else MicrophoneMediaService.current = this
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        if (intent?.action == "stop") {
            MediaController.close()
            if (request == null) stopSelf()
            return START_NOT_STICKY
        }
        val next = MediaController.pending(camera, intent?.getIntExtra("stream", 0) ?: 0)
        if (next == null || finishing.get()) {
            if (request == null) stopSelf()
            return START_NOT_STICKY
        }
        if (request === next) return START_NOT_STICKY
        check(request == null)
        request = next
        try {
            val why = next.invalid()
            if (why != 0) {
                MediaController.end(next, why)
                return START_NOT_STICKY
            }
            startForeground(
                notificationId,
                notificationValue(),
                if (camera) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
            MediaController.updateNotifications()
            handler.post {
                if (next.active.get()) {
                    try {
                        open(next)
                    } catch (error: CameraAccessException) {
                        fail(
                            next,
                            if (error.reason in
                                listOf(CameraAccessException.CAMERA_IN_USE, CameraAccessException.MAX_CAMERAS_IN_USE)
                            ) {
                                3
                            } else {
                                4
                            },
                        )
                    } catch (_: SecurityException) {
                        fail(next, 1)
                    } catch (_: Exception) {
                        fail(next, 4)
                    }
                }
            }
        } catch (_: SecurityException) {
            MediaController.end(next, 1)
        } catch (_: Exception) {
            MediaController.end(next, 4)
        }
        return START_NOT_STICKY
    }

    protected fun fail(
        request: MediaController.Request,
        reason: Int,
    ) {
        MediaController.main.post { MediaController.end(request, reason) }
    }

    internal fun finish() {
        if (!finishing.compareAndSet(false, true)) return
        request?.active?.set(false)
        handler.post {
            closeNative {
                worker.quitSafely()
                MediaController.main.post {
                    closed = true
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    if (destroyed) request?.released() else stopSelf()
                }
            }
        }
    }

    internal fun notification() {
        if (request != null &&
            !finishing.get()
        ) {
            getSystemService(NotificationManager::class.java).notify(notificationId, notificationValue())
        }
    }

    private fun notificationValue(): Notification {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("remote-media", "Camera and microphone sharing", NotificationManager.IMPORTANCE_LOW),
        )
        val stop = PendingIntent.getService(this, 0, Intent(this, javaClass).setAction("stop"), PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification
            .Builder(this, "remote-media")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("${MediaController.labels()} sharing")
            .setContentText("${request?.label ?: "Paired controller"} · Stop to end sharing")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop sharing", stop).build())
            .build()
    }

    override fun onDestroy() {
        destroyed = true
        request?.let { if (it.active.get()) MediaController.end(it, 8) }
        finish()
        if (closed) request?.released()
        if (camera && CameraMediaService.current === this) CameraMediaService.current = null
        if (!camera && MicrophoneMediaService.current === this) MicrophoneMediaService.current = null
        super.onDestroy()
    }

    protected abstract fun open(request: MediaController.Request)

    protected abstract fun closeNative(done: () -> Unit)
}

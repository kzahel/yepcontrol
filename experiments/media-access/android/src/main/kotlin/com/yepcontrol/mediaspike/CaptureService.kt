package com.yepcontrol.mediaspike

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.ImageReader
import android.media.MediaRecorder
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder

class CaptureService : Service() {
    private val worker = HandlerThread("media-probe").apply { start() }
    private val handler = Handler(worker.looper)
    private var camera: CameraDevice? = null
    private var reader: ImageReader? = null
    private var session: CameraCaptureSession? = null
    private var audio: AudioRecord? = null
    private var audioThread: Thread? = null

    @Volatile private var recording = false

    @Volatile private var generation = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        if (intent?.action == "stop") {
            Probe.end()
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel("media", "Media experiment", NotificationManager.IMPORTANCE_LOW),
            )
            val stop =
                PendingIntent.getService(
                    this,
                    1,
                    Intent(this, CaptureService::class.java).setAction("stop"),
                    PendingIntent.FLAG_IMMUTABLE,
                )
            val notification =
                Notification
                    .Builder(this, "media")
                    .setSmallIcon(android.R.drawable.ic_menu_camera)
                    .setContentTitle("YepControl camera and microphone test enabled")
                    .setContentText("Remote test may use sensors for up to two minutes. Tap Stop to end.")
                    .setOngoing(true)
                    .addAction(Notification.Action.Builder(null, "Stop", stop).build())
                    .build()
            startForeground(71, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            instance = this
            Probe.event("armed")
        } catch (error: Exception) {
            Probe.event("error", "foreground: ${error.javaClass.simpleName}: ${error.message}")
            stopSelf()
        }
        return START_NOT_STICKY
    }

    @SuppressLint("MissingPermission") // A deliberately tested runtime prerequisite; errors are reported.
    fun camera() {
        if (reader != null) return
        val current = generation
        val manager = getSystemService(CameraManager::class.java)
        val id =
            manager.cameraIdList.firstOrNull {
                manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            } ?: manager.cameraIdList.first()
        val size =
            manager
                .getCameraCharacteristics(id)
                .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!
                .getOutputSizes(ImageFormat.JPEG)
                .minByOrNull { it.width * it.height }
                ?: error("No JPEG size")
        reader =
            ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2).apply {
                setOnImageAvailableListener({ source ->
                    source.acquireLatestImage()?.use { image ->
                        val buffer = image.planes[0].buffer
                        val bytes = ByteArray(buffer.remaining())
                        buffer.get(bytes)
                        Probe.media(1, bytes)
                    }
                }, handler)
            }
        manager.openCamera(
            id,
            object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    if (current != generation) {
                        device.close()
                        return
                    }
                    camera = device
                    val surface = checkNotNull(reader).surface
                    @Suppress("DEPRECATION")
                    device.createCaptureSession(
                        listOf(surface),
                        object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(capture: CameraCaptureSession) {
                                if (current != generation) {
                                    capture.close()
                                    return
                                }
                                session = capture
                                try {
                                    val request =
                                        device
                                            .createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                                            .apply {
                                                addTarget(surface)
                                                set(CaptureRequest.JPEG_QUALITY, 45.toByte())
                                            }.build()
                                    capture.setRepeatingRequest(request, null, handler)
                                    Probe.event("camera-started", "${size.width}x${size.height}")
                                } catch (error: Exception) {
                                    Probe.event("error", "camera request: ${error.javaClass.simpleName}")
                                }
                            }

                            override fun onConfigureFailed(capture: CameraCaptureSession) {
                                Probe.event("error", "camera configure")
                            }
                        },
                        handler,
                    )
                }

                override fun onDisconnected(device: CameraDevice) {
                    device.close()
                    Probe.event("camera-disconnected")
                }

                override fun onError(
                    device: CameraDevice,
                    error: Int,
                ) {
                    device.close()
                    Probe.event("error", "camera=$error")
                }
            },
            handler,
        )
    }

    @SuppressLint("MissingPermission")
    fun microphone() {
        if (audio != null) return
        val recorder =
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                16_000,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(6400, AudioRecord.getMinBufferSize(16_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)),
            )
        audio = recorder
        recorder.startRecording()
        recording = true
        audioThread =
            Thread {
                val bytes = ByteArray(640)
                while (recording) {
                    val count = recorder.read(bytes, 0, bytes.size)
                    if (count > 0) Probe.media(2, bytes.copyOf(count)) else break
                }
            }.apply { start() }
        Probe.event("microphone-started", "PCM16LE mono 16000Hz")
    }

    @Synchronized fun off() {
        generation++
        session?.close()
        session = null
        camera?.close()
        camera = null
        reader?.close()
        reader = null
        recording = false
        audio?.stop()
        audioThread?.join(1000)
        audioThread = null
        audio?.release()
        audio = null
        Probe.event("off")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        off()
        worker.quitSafely()
        Probe.event("disarmed")
        super.onDestroy()
    }

    companion object {
        var instance: CaptureService? = null
            private set
    }
}

package dev.remoteaccess.app.media

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.display.DisplayManager
import android.media.Image
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.SystemClock
import android.view.WindowManager
import dev.remoteaccess.protocol.PendingResource
import dev.remoteaccess.protocol.YuvPlane
import java.io.ByteArrayOutputStream

/** One worker owns Camera2, image planes and the encoder. Frames are physically upright. */
internal class CameraMediaService : SensorMediaService(true) {
    private val resource = PendingResource<CameraDevice> { it.close() }
    private var capture: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var codec: MediaCodec? = null
    private var displayListener: DisplayManager.DisplayListener? = null
    private var configuration = byteArrayOf()
    private var lastFrame = 0L
    private var rotation = 0
    private var width = 0
    private var height = 0

    @SuppressLint("MissingPermission") // Permission is checked before and throughout capture.
    override fun open(request: MediaController.Request) {
        val manager = getSystemService(CameraManager::class.java)
        val id = MediaController.cameras(this)[request.facing] ?: error("Facing unavailable")
        val characteristics = manager.getCameraCharacteristics(id)
        val sizes =
            checkNotNull(characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP))
                .getOutputSizes(ImageFormat.YUV_420_888)
                .filter {
                    it.width <= 1280 &&
                        it.height <= 1280 &&
                        it.width % 2 == 0 &&
                        it.height % 2 == 0
                }
        val size = sizes.minByOrNull { kotlin.math.abs(it.width * it.height - 640 * 480) } ?: error("No bounded capture size")

        @Suppress("DEPRECATION")
        val displayRotation = getSystemService(WindowManager::class.java).defaultDisplay.rotation
        val displays = getSystemService(DisplayManager::class.java)
        displayListener =
            object : DisplayManager.DisplayListener {
                override fun onDisplayAdded(displayId: Int) = Unit

                override fun onDisplayRemoved(displayId: Int) = Unit

                @Suppress("DEPRECATION")
                override fun onDisplayChanged(displayId: Int) {
                    if (getSystemService(WindowManager::class.java).defaultDisplay.rotation != displayRotation) fail(request, 8)
                }
            }.also { displays.registerDisplayListener(it, handler) }
        val degrees = displayRotation * 90
        rotation = (
            (characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0) +
                (if (request.facing == 2) degrees else -degrees) + 360
        ) % 360
        width = if (rotation % 180 == 0) size.width else size.height
        height = if (rotation % 180 == 0) size.height else size.width
        if (request.format == 2) configureEncoder(request)
        reader =
            ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2).apply {
                setOnImageAvailableListener({ source ->
                    runCatching {
                        source.acquireLatestImage()?.use { image ->
                            if (!request.active.get()) return@use
                            val now = SystemClock.elapsedRealtimeNanos() / 1000
                            if (now - lastFrame < 1000000L / request.fps) return@use
                            lastFrame = now
                            if (request.format == 1) jpeg(request, image) else encode(request, image, now)
                        }
                    }.onFailure { fail(request, 8) }
                }, handler)
            }
        resource.starting()
        try {
            manager.openCamera(
                id,
                object : CameraDevice.StateCallback() {
                    override fun onOpened(camera: CameraDevice) {
                        if (!resource.arrived(camera, request.active.get())) return
                        try {
                            val surface = checkNotNull(reader).surface
                            @Suppress("DEPRECATION")
                            camera.createCaptureSession(
                                listOf(surface),
                                object : CameraCaptureSession.StateCallback() {
                                    override fun onConfigured(session: CameraCaptureSession) {
                                        if (!request.active.get()) {
                                            session.close()
                                            return
                                        }
                                        capture = session
                                        try {
                                            val ranges =
                                                characteristics
                                                    .get(
                                                        CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES,
                                                    ).orEmpty()
                                            val range =
                                                ranges.filter { it.upper >= request.fps }.minByOrNull { it.upper * 100 + it.lower }
                                                    ?: ranges.minByOrNull { it.upper }
                                            val value =
                                                camera
                                                    .createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
                                                    .apply {
                                                        addTarget(surface)
                                                        set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                                                        if (range != null) set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, range)
                                                    }.build()
                                            session.setRepeatingRequest(value, null, handler)
                                        } catch (_: Exception) {
                                            fail(request, 4)
                                        }
                                    }

                                    override fun onConfigureFailed(session: CameraCaptureSession) {
                                        session.close()
                                        fail(request, 4)
                                    }
                                },
                                handler,
                            )
                        } catch (_: Exception) {
                            fail(request, 4)
                        }
                    }

                    override fun onDisconnected(camera: CameraDevice) {
                        resource.arrived(camera, false)
                        fail(request, 8)
                    }

                    override fun onError(
                        camera: CameraDevice,
                        error: Int,
                    ) {
                        resource.arrived(camera, false)
                        fail(
                            request,
                            when (error) {
                                ERROR_CAMERA_IN_USE, ERROR_MAX_CAMERAS_IN_USE -> 3
                                ERROR_CAMERA_DISABLED -> 1
                                else -> 4
                            },
                        )
                    }

                    override fun onClosed(camera: CameraDevice) {
                        resource.closed(camera)
                        if (request.active.get()) fail(request, 8)
                    }
                },
                handler,
            )
        } catch (error: Exception) {
            resource.failed()
            throw error
        }
    }

    private fun configureEncoder(request: MediaController.Request) {
        val format =
            MediaFormat.createVideoFormat("video/avc", width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
                setInteger(MediaFormat.KEY_BIT_RATE, 1000000)
                setInteger(MediaFormat.KEY_FRAME_RATE, request.fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
                setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            }
        val encoder = MediaCodec.createEncoderByType("video/avc")
        codec = encoder
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        encoder.start()
        val drain =
            object : Runnable {
                override fun run() {
                    if (!request.active.get()) return
                    try {
                        drain(request)
                        handler.postDelayed(this, 10)
                    } catch (_: Exception) {
                        fail(request, 4)
                    }
                }
            }
        handler.post(drain)
    }

    private fun encode(
        request: MediaController.Request,
        image: Image,
        timestamp: Long,
    ) {
        val encoder = checkNotNull(codec)
        val index = encoder.dequeueInputBuffer(0)
        if (index < 0) return // bounded drop before encoding; no broken reference chain.
        val input = checkNotNull(encoder.getInputImage(index))
        try {
            for (plane in 0..2) {
                val scale = if (plane == 0) 1 else 2
                val sw = image.width / scale
                val sh = image.height / scale
                val source = image.planes[plane]
                val target = input.planes[plane]
                // Bulk access avoids a JNI/direct-buffer operation for every pixel. Preserve
                // the target's other chroma bytes when planes share an interleaved buffer.
                val from = ByteArray(source.buffer.remaining()).also { source.buffer.duplicate().get(it) }
                val to = ByteArray(target.buffer.remaining()).also { target.buffer.duplicate().get(it) }
                YuvPlane.rotate(from, source.rowStride, source.pixelStride, to, target.rowStride, target.pixelStride, sw, sh, rotation)
                target.buffer.duplicate().put(to)
            }
        } finally {
            input.close()
        }
        encoder.queueInputBuffer(index, 0, width * height * 3 / 2, timestamp, 0)
        drain(request)
    }

    private fun drain(request: MediaController.Request) {
        val encoder = checkNotNull(codec)
        val info = MediaCodec.BufferInfo()
        repeat(8) {
            val index = encoder.dequeueOutputBuffer(info, 0)
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                configuration =
                    listOf("csd-0", "csd-1")
                        .flatMap { name ->
                            encoder.outputFormat
                                .getByteBuffer(name)
                                ?.let { buffer ->
                                    ByteArray(buffer.remaining()).also { buffer.get(it) }.toList()
                                }.orEmpty()
                        }.toByteArray()
            } else if (index >= 0) {
                try {
                    if (info.size > 1048544) {
                        fail(request, 4)
                        return
                    }
                    val bytes = ByteArray(info.size)
                    encoder.getOutputBuffer(index)?.apply {
                        position(info.offset)
                        get(bytes)
                    }
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        configuration = bytes
                    } else if (bytes.isNotEmpty()) {
                        val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                        request.offer(2, if (key) configuration + bytes else bytes, width, height, key)
                    }
                } finally {
                    encoder.releaseOutputBuffer(index, false)
                }
            } else {
                return
            }
        }
    }

    private fun jpeg(
        request: MediaController.Request,
        image: Image,
    ) {
        val sw = image.width
        val sh = image.height
        val nv21 = ByteArray(sw * sh * 3 / 2)
        for (plane in 0..2) {
            val value = image.planes[plane]
            val base = value.buffer.position()
            val scale = if (plane == 0) 1 else 2
            for (y in 0 until sh / scale) {
                for (x in 0 until sw / scale) {
                    val target = if (plane == 0) y * sw + x else sw * sh + y * sw + x * 2 + if (plane == 2) 0 else 1
                    nv21[target] = value.buffer.get(base + y * value.rowStride + x * value.pixelStride)
                }
            }
        }
        val output = ByteArrayOutputStream()
        check(YuvImage(nv21, ImageFormat.NV21, sw, sh, null).compressToJpeg(Rect(0, 0, sw, sh), 75, output))
        var bytes = output.toByteArray()
        if (rotation != 0) {
            val bitmap = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
            val upright = Bitmap.createBitmap(bitmap, 0, 0, sw, sh, Matrix().apply { postRotate(rotation.toFloat()) }, false)
            try {
                output.reset()
                check(upright.compress(Bitmap.CompressFormat.JPEG, 75, output))
                bytes = output.toByteArray()
            } finally {
                if (upright !== bitmap) upright.recycle()
                bitmap.recycle()
            }
        }
        if (bytes.size > 1048544) fail(request, 4) else request.offer(1, bytes, width, height)
    }

    override fun closeNative(done: () -> Unit) {
        displayListener?.let { getSystemService(DisplayManager::class.java).unregisterDisplayListener(it) }
        displayListener = null
        runCatching { capture?.stopRepeating() }
        runCatching { capture?.close() }
        capture = null
        runCatching { reader?.close() }
        reader = null
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
        resource.release(done)
    }

    companion object {
        internal var current: SensorMediaService? = null
    }
}

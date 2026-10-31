package dev.remoteaccess.app.media

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock

internal class MicrophoneMediaService : SensorMediaService(false) {
    private var recorder: AudioRecord? = null
    private var opened = 0L
    private val bytes = ByteArray(640) // 20 ms, with no independent unbounded reader thread.

    @SuppressLint("MissingPermission") // Controller preflight + live checks; SecurityException ends capture.
    override fun open(request: MediaController.Request) {
        val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0)
        val value =
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                16000,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minimum, 6400),
            )
        recorder = value
        check(value.state == AudioRecord.STATE_INITIALIZED)
        value.startRecording()
        check(value.recordingState == AudioRecord.RECORDSTATE_RECORDING)
        opened = SystemClock.elapsedRealtime()
        val read =
            object : Runnable {
                override fun run() {
                    if (!request.active.get()) return
                    try {
                        if (getSystemService(AudioManager::class.java).isMicrophoneMute) {
                            fail(request, 1)
                            return
                        }
                        val configuration = value.activeRecordingConfiguration
                        if (configuration?.isClientSilenced == true) {
                            fail(request, 3)
                            return
                        }
                        val count = value.read(bytes, 0, bytes.size, AudioRecord.READ_NON_BLOCKING)
                        if (count < 0 || count % 2 != 0) {
                            fail(request, 8)
                            return
                        }
                        if (count > 0 && !request.offer(3, bytes.copyOf(count), 16000, 1)) return
                        // An unconfigured recording stream is not evidence of working capture.
                        if (configuration == null && SystemClock.elapsedRealtime() - opened > 1000) {
                            fail(request, 4)
                            return
                        }
                        handler.postDelayed(this, if (count == bytes.size) 1 else 10)
                    } catch (_: Exception) {
                        fail(request, 8)
                    }
                }
            }
        handler.post(read)
    }

    override fun closeNative(done: () -> Unit) {
        recorder?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        recorder = null
        done()
    }

    companion object {
        internal var current: SensorMediaService? = null
    }
}

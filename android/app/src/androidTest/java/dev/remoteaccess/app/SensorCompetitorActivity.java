package dev.remoteaccess.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureRequest;
import android.media.ImageReader;
import android.graphics.ImageFormat;
import java.util.Collections;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Separate UID, foreground sensor contender. Only in the owned-emulator test APK. */
public final class SensorCompetitorActivity extends Activity {
    private CameraDevice camera;
    private CameraCaptureSession cameraSession;
    private ImageReader cameraReader;
    private boolean cameraActive;
    private AudioRecord microphone;
    private final Handler main = new Handler(Looper.getMainLooper());

    @SuppressLint({"MissingPermission", "SetTextI18n"})
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView label = new TextView(this);
        label.setText("Independent sensor contention fixture");
        setContentView(label);
        String sensor = getIntent().getStringExtra("sensor");
        try {
            if ("camera".equals(sensor)) {
                CameraManager manager = getSystemService(CameraManager.class);
                String selected = null;
                for (String id : manager.getCameraIdList()) {
                    if (Integer.valueOf(CameraCharacteristics.LENS_FACING_BACK).equals(manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING))) { selected = id; break; }
                }
                if (selected == null) throw new IllegalStateException("No rear camera");
                manager.openCamera(selected, new CameraDevice.StateCallback() {
                    @Override public void onOpened(CameraDevice value) {
                        camera = value; cameraActive = true;
                        cameraReader = ImageReader.newInstance(640, 480, ImageFormat.YUV_420_888, 2);
                        cameraReader.setOnImageAvailableListener(reader -> {
                            try (android.media.Image image = reader.acquireLatestImage()) {
                                if (image != null && cameraActive) witness("camera-streaming", false);
                            } catch (IllegalStateException ignored) { /* Late callback after close. */ }
                        }, main);
                        try {
                            value.createCaptureSession(Collections.singletonList(cameraReader.getSurface()), new CameraCaptureSession.StateCallback() {
                                @Override public void onConfigured(CameraCaptureSession session) {
                                    if (!cameraActive || camera != value) { session.close(); return; }
                                    cameraSession = session;
                                    try {
                                        CaptureRequest.Builder request = value.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                                        request.addTarget(cameraReader.getSurface());
                                        session.setRepeatingRequest(request.build(), null, main);
                                    } catch (Exception error) { closeCamera(); witness("camera-stream-error", true); }
                                }
                                @Override public void onConfigureFailed(CameraCaptureSession session) { session.close(); closeCamera(); witness("camera-config-error", true); }
                            }, main);
                        } catch (Exception error) { closeCamera(); witness("camera-session-error", true); }
                    }
                    @Override public void onDisconnected(CameraDevice value) { closeCamera(); value.close(); witness("camera-disconnected", false); }
                    @Override public void onError(CameraDevice value, int error) { closeCamera(); value.close(); witness("camera-error", false); }
                }, main);
            } else {
                AudioFormat format = new AudioFormat.Builder().setSampleRate(16000)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build();
                microphone = new AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.CAMCORDER)
                    .setAudioFormat(format).setPrivacySensitive(true).setBufferSizeInBytes(6400).build();
                microphone.startRecording();
                main.post(new Runnable() {
                    @Override public void run() {
                        if (microphone == null) return;
                        byte[] discard = new byte[640];
                        microphone.read(discard, 0, discard.length, AudioRecord.READ_NON_BLOCKING);
                        android.media.AudioRecordingConfiguration config = microphone.getActiveRecordingConfiguration();
                        witness("microphone-recording", config == null || config.isClientSilenced());
                        main.postDelayed(this, 50);
                    }
                });
            }
        } catch (Exception error) { witness("error-" + error.getClass().getSimpleName(), true); }
    }

    private void witness(String event, boolean silenced) {
        try {
            byte[] bytes = new JSONObject().put("event", event).put("silenced", silenced).toString().getBytes(StandardCharsets.UTF_8);
            File next = new File(getFilesDir(), "sensor-witness.next");
            try (FileOutputStream out = new FileOutputStream(next)) { out.write(bytes); }
            if (!next.renameTo(new File(getFilesDir(), "sensor-witness.json"))) throw new IllegalStateException();
        } catch (Exception error) { throw new IllegalStateException("Sensor witness failed", error); }
    }

    private void closeCamera() {
        cameraActive = false;
        if (cameraSession != null) { cameraSession.close(); cameraSession = null; }
        if (camera != null) { camera.close(); camera = null; }
        if (cameraReader != null) { cameraReader.close(); cameraReader = null; }
    }

    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        closeCamera();
        if (microphone != null) { microphone.stop(); microphone.release(); microphone = null; }
        super.onDestroy();
    }
}

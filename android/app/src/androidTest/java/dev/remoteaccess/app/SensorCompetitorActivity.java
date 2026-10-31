package dev.remoteaccess.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.hardware.camera2.CameraDevice;
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
                    @Override public void onOpened(CameraDevice value) { camera = value; witness("camera-open", false); }
                    @Override public void onDisconnected(CameraDevice value) { value.close(); witness("camera-disconnected", false); }
                    @Override public void onError(CameraDevice value, int error) { value.close(); witness("camera-error", false); }
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

    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (camera != null) { camera.close(); camera = null; }
        if (microphone != null) { microphone.stop(); microphone.release(); microphone = null; }
        super.onDestroy();
    }
}

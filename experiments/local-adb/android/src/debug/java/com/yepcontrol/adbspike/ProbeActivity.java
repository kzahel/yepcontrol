package com.yepcontrol.adbspike;

import android.app.Activity;
import android.content.Intent;
import android.os.*;
import java.io.File;
import java.nio.file.Files;
import org.json.JSONObject;

/** CLI acceptance stimuli without instrumentation's force-stop of the target process. */
public final class ProbeActivity extends Activity {
    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        String op = getIntent().getStringExtra("op"), id = getIntent().getStringExtra("id");
        if (id == null || !id.matches("[a-z0-9-]{1,80}")) { finish(); return; }
        if ("tap".equals(op) || "sensitivity-and-tap".equals(op)) startActivity(new Intent(this, ProtectedActivity.class));
        new Handler(getMainLooper()).postDelayed(() -> new Thread(() -> {
            try {
                JSONObject result = new JSONObject().put("id", id);
                switch (op) {
                    case "tap":
                    case "sensitivity-and-tap":
                        JSONObject before = new JSONObject(new String(Files.readAllBytes(new File(getNoBackupFilesDir(), "fixture.json").toPath()), java.nio.charset.StandardCharsets.UTF_8));
                        if ("sensitivity-and-tap".equals(op)) {
                            JSONObject tree = Broker.call(this, new JSONObject().put("op", "sensitivity")).getJSONObject("tree");
                            if (Build.VERSION.SDK_INT >= 34 && tree.getInt("sensitive") == 0) throw new IllegalStateException("No sensitive target");
                            result.put("sensitivity", tree).put("sensitiveProtectionSupported", Build.VERSION.SDK_INT >= 34);
                        }
                        JSONObject pong = Broker.call(this, new JSONObject().put("op", "tap").put("x", before.getInt("x")).put("y", before.getInt("y")));
                        Thread.sleep(500);
                        JSONObject after = new JSONObject(new String(Files.readAllBytes(new File(getNoBackupFilesDir(), "fixture.json").toPath()), java.nio.charset.StandardCharsets.UTF_8));
                        if (after.getInt("count") != before.getInt("count") + 1) throw new IllegalStateException("Tap not delivered");
                        result.put("helperPid", pong.getInt("pid")).put("tapDelivered", true); break;
                    case "stop-helper":
                        result.put("oldPid", Broker.call(this, new JSONObject().put("op", "stop")).getInt("pid")); break;
                    case "off":
                        Store.prefs(this).edit().putBoolean("enabled", false).commit();
                        try { Broker.call(this, new JSONObject().put("op", "stop")); } catch (Exception ignored) {}
                        stopService(new Intent(this, AdvancedService.class)); Store.record(this, "off", ""); break;
                    default: throw new IllegalArgumentException();
                }
                Store.receipt(this, "probe", result.put("ok", true));
            } catch (Exception e) {
                try { Store.receipt(this, "probe", new JSONObject().put("id", id).put("ok", false).put("error", e.getClass().getSimpleName())); }
                catch (Exception ignored) {}
            }
            runOnUiThread(this::finish);
        }, "acceptance-probe").start(), 1000);
    }
}

package com.yepcontrol.adbspike;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class Store {
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("advanced", Context.MODE_PRIVATE); }
    static int boot(Context c) { return Settings.Global.getInt(c.getContentResolver(), Settings.Global.BOOT_COUNT, -1); }
    static boolean enabled(Context c) { return prefs(c).getBoolean("enabled", false); }
    static void record(Context c, String phase, String error) {
        try {
            JSONObject v = new JSONObject().put("phase", phase).put("error", error)
                .put("enabled", enabled(c)).put("paired", prefs(c).getBoolean("paired", false))
                .put("automatic", prefs(c).getBoolean("automatic", false)).put("boot", boot(c))
                .put("settingsGrant", c.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == android.content.pm.PackageManager.PERMISSION_GRANTED)
                .put("wirelessEnabled", Settings.Global.getInt(c.getContentResolver(), "adb_wifi_enabled", 0) == 1)
                .put("helperPid", prefs(c).getInt("helperPid", 0)).put("helperUid", prefs(c).getInt("helperUid", -1))
                .put("attestedUid", prefs(c).getInt("attestedUid", -1))
                .put("restoreRequests", prefs(c).getInt("restoreRequests", 0)).put("restoreBoot", prefs(c).getInt("restoreBoot", -1))
                .put("identity", prefs(c).getString("identity", "")).put("elapsedMs", android.os.SystemClock.elapsedRealtime());
            AtomicFile file = new AtomicFile(new File(c.getNoBackupFilesDir(), "status.json"));
            FileOutputStream out = file.startWrite();
            try { out.write(v.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); }
            catch (Exception e) { file.failWrite(out); throw e; }
        } catch (Exception ignored) { /* No keys, tokens or pairing codes enter diagnostics. */ }
    }
    static void receipt(Context c, String name, JSONObject value) {
        try (FileOutputStream out = new FileOutputStream(new File(c.getNoBackupFilesDir(), name + ".json"))) {
            out.write(value.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
}

package com.yepcontrol.adbspike;

import android.app.*;
import android.content.*;
import android.os.*;
import android.provider.Settings;
import android.widget.*;
import java.io.File;
import java.nio.file.Files;

public final class MainActivity extends Activity {
    final Handler handler = new Handler(Looper.getMainLooper());
    TextView status;
    final Runnable refresh = new Runnable() {
        public void run() {
            try { status.setText(new String(Files.readAllBytes(new File(getNoBackupFilesDir(), "status.json").toPath()), java.nio.charset.StandardCharsets.UTF_8)); }
            catch (Exception e) { status.setText("Off — advanced setup has not been started."); }
            handler.postDelayed(this, 1000);
        }
    };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(24, 48, 24, 24);
        ScrollView scroll = new ScrollView(this); scroll.addView(content); setContentView(scroll);
        TextView title = new TextView(this); title.setText("Advanced control experiment\n\nSeparate test app. Pair with this phone’s Wireless debugging using its notification. Requires Developer options and Wi-Fi. First unlock after reboot remains local."); content.addView(title);
        CheckBox automatic = new CheckBox(this); automatic.setId(R.id.automatic); automatic.setText("Automatically restore after restart (grants settings permission)");
        automatic.setChecked(Store.prefs(this).getBoolean("automatic", false)); content.addView(automatic);
        automatic.setOnCheckedChangeListener((v, checked) -> Store.prefs(this).edit().putBoolean("automatic", checked).commit());
        button(content, R.id.start, "Set up on this phone", () -> {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
            Store.prefs(this).edit().putBoolean("enabled", true).commit();
            startForegroundService(new Intent(this, AdvancedService.class));
        });
        button(content, R.id.settings, "Open Developer settings", () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)));
        button(content, R.id.comparison, "Enable comparison accessibility service", () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        button(content, R.id.fixture, "Open protected test screen", () -> startActivity(new Intent(this, ProtectedActivity.class)));
        button(content, R.id.stop, "Turn advanced control off", () -> {
            Store.prefs(this).edit().putBoolean("enabled", false).commit(); stopService(new Intent(this, AdvancedService.class)); Store.record(this, "off", "");
        });
        status = new TextView(this); status.setId(R.id.status); content.addView(status);
        if (!Store.enabled(this)) Store.record(this, "off", "");
        else startForegroundService(new Intent(this, AdvancedService.class));
    }
    void button(LinearLayout parent, int id, String label, Runnable action) {
        Button button = new Button(this); button.setId(id); button.setText(label); parent.addView(button); button.setOnClickListener(v -> action.run());
    }
    @Override public void onResume() { super.onResume(); handler.post(refresh); }
    @Override public void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
}

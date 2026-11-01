package com.yepcontrol.adbspike;

import android.app.*;
import android.content.*;
import android.net.*;
import android.os.*;
import android.provider.Settings;
import java.util.concurrent.*;
import org.json.JSONObject;

public final class AdvancedService extends Service {
    static final String CHANNEL = "advanced";
    final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    volatile boolean closed;
    int restoreAttempts;
    long wifiSince;
    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Advanced control experiment", NotificationManager.IMPORTANCE_DEFAULT));
        startForeground(1, notification("Starting"));
        worker.scheduleWithFixedDelay(this::tick, 0, 5, TimeUnit.SECONDS);
    }
    Notification notification(String text) {
        Intent intent = new Intent(this, PairReceiver.class);
        PendingIntent reply = PendingIntent.getBroadcast(this, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        RemoteInput code = new RemoteInput.Builder("code").setLabel("Wireless debugging pairing code").build();
        Notification.Action action = new Notification.Action.Builder(android.R.drawable.ic_lock_lock, "Enter pairing code", reply).addRemoteInput(code).build();
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_lock_lock).setContentTitle("Local advanced control spike")
            .setContentText(text).setOngoing(true).addAction(action).build();
    }
    void state(String phase, Exception error) {
        Store.record(this, phase, error == null ? "" : error.getClass().getSimpleName());
        getSystemService(NotificationManager.class).notify(1, notification(phase));
    }
    void tick() {
        if (closed || !Store.enabled(this)) return;
        try {
            boolean helperAlive = false;
            try { Broker.call(this, new JSONObject().put("op", "ping")); helperAlive = true; }
            catch (Exception ignored) {}
            boolean needsGrant = Store.prefs(this).getBoolean("automatic", false)
                && checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (helperAlive && !needsGrant) { state("ready", null); return; }
            if (!Store.prefs(this).getBoolean("paired", false)) { state("awaiting-pairing", null); return; }
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            boolean wifi = false;
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities cap = cm.getNetworkCapabilities(n);
                if (cap != null && cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifi = true;
            }
            if (!wifi) { wifiSince = 0; restoreAttempts = 0; state("waiting-for-wifi", null); return; }
            long now = SystemClock.elapsedRealtime();
            if (wifiSince == 0) wifiSince = now;
            if (Settings.Global.getInt(getContentResolver(), "adb_wifi_enabled", 0) == 0) {
                if (!Store.prefs(this).getBoolean("automatic", false) || checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    state("start-wireless-debugging-on-phone", null); return;
                }
                // Wi-Fi transport can appear before adbd accepts it as a connected network.
                if (now - wifiSince < 5000) { state("waiting-for-wifi-ready", null); return; }
                if (restoreAttempts >= 3) { state("start-wireless-debugging-on-phone", null); return; }
                restoreAttempts++;
                Settings.Global.putInt(getContentResolver(), "adb_wifi_enabled", 1);
                state("restoring-wireless-debugging", null);
            }
            try (LocalDiscovery discovery = new LocalDiscovery(this, "_adb-tls-connect._tcp." ); Identity adb = new Identity(this)) {
                state("connecting-locally", null);
                adb.setTimeout(8, TimeUnit.SECONDS);
                if (!adb.connect("127.0.0.1", discovery.await(15))) throw new IllegalStateException("Connection refused");
                if (!Broker.shell(adb, "id -u").equals("2000")) throw new SecurityException("Not shell");
                if (Store.prefs(this).getBoolean("automatic", false) && checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    Broker.shell(adb, "pm grant " + getPackageName() + " android.permission.WRITE_SECURE_SETTINGS");
                    if (checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != android.content.pm.PackageManager.PERMISSION_GRANTED) throw new SecurityException("Restart permission not granted");
                    Store.prefs(this).edit().putBoolean("selfGranted", true).commit();
                }
                if (!helperAlive) Broker.start(this, adb);
                restoreAttempts = 0; state("ready", null);
            }
        } catch (Exception e) { if (!closed) { android.util.Log.e("LocalAdbSpike", "Recovery failed", e); state("repair-needed", e); } }
    }
    @Override public int onStartCommand(Intent i, int flags, int id) {
        if (i != null && !i.hasExtra("code")) worker.execute(() -> { restoreAttempts = 0; wifiSince = 0; });
        if (i != null && i.hasExtra("code")) {
            String code = i.getStringExtra("code");
            worker.execute(() -> {
                try (LocalDiscovery discovery = new LocalDiscovery(this, "_adb-tls-pairing._tcp."); Identity adb = new Identity(this)) {
                    state("pairing-locally", null);
                    if (!adb.pair("127.0.0.1", discovery.await(20), code)) throw new SecurityException("Pairing failed");
                    Store.prefs(this).edit().putBoolean("paired", true).commit(); state("paired", null);
                } catch (Exception e) { state("pairing-failed", e); }
            });
        }
        return START_STICKY;
    }
    @Override public void onDestroy() {
        closed = true; worker.shutdownNow();
        if (!Store.enabled(this)) new Thread(() -> {
            try { Broker.call(this, new JSONObject().put("op", "stop")); } catch (Exception ignored) {}
            Store.record(this, "off", "");
        }).start();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent i) { return null; }
}

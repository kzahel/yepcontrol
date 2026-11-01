// SPDX-License-Identifier: MIT
package dev.remoteaccess.app.advanced;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.*;
import android.os.*;
import android.provider.Settings;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Explicitly started, bounded helper. The OS must never restart or boot-arm it. */
public final class AdvancedService extends Service {
  private static final String CHANNEL = "advanced-control";
  private static final int NOTICE = 47;
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private volatile boolean closed;
  private volatile Identity activeAdb;
  private long started;
  private int enableAttempts;
  private boolean hadReady;
  private final String epoch = java.util.UUID.randomUUID().toString();

  @Override
  public void onCreate() {
    super.onCreate();
    Store.epoch = epoch;
    Store.running = true;
    Store.ready = false;
    started = SystemClock.elapsedRealtime();
    getSystemService(NotificationManager.class)
        .createNotificationChannel(
            new NotificationChannel(
                CHANNEL, "Advanced control", NotificationManager.IMPORTANCE_DEFAULT));
    startForeground(NOTICE, notification("Starting advanced control"));
    worker.scheduleWithFixedDelay(this::tick, 1, 4, TimeUnit.SECONDS);
  }

  private Notification notification(String text) {
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            47,
            new Intent(this, dev.remoteaccess.app.MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop =
        PendingIntent.getService(
            this,
            48,
            new Intent(this, AdvancedService.class).setAction("stop"),
            PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder n =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("YepControl advanced control")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build());
    if (!AdvancedControl.paired(this)) {
      PendingIntent reply =
          PendingIntent.getBroadcast(
              this,
              47,
              new Intent(this, PairReceiver.class),
              PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
      n.addAction(
          new Notification.Action.Builder(null, "Enter pairing code", reply)
              .addRemoteInput(
                  new RemoteInput.Builder("code").setLabel("Six-digit pairing code").build())
              .build());
    }
    return n.build();
  }

  private void state(String value) {
    if (closed) return;
    Store.phase = value;
    getSystemService(NotificationManager.class).notify(NOTICE, notification(value));
  }

  private void tick() {
    if (closed) return;
    long age = SystemClock.elapsedRealtime() - started;
    if (age > 3600000 || (!hadReady && age > 300000)) {
      state("Stopped · press Start to try again");
      stopSelf();
      return;
    }
    try {
      if (Store.ready) {
        try {
          Broker.call(this, new JSONObject().put("op", "ping"));
          return;
        } catch (Exception e) {
          Store.ready = false;
          state("Connection ended · press Stop, then Start");
          stopSelf();
          return;
        }
      }
      if (!AdvancedControl.paired(this)) {
        state("Set up Wireless debugging and enter its pairing code");
        return;
      }
      ConnectivityManager cm = getSystemService(ConnectivityManager.class);
      boolean wifi = false;
      for (Network network : cm.getAllNetworks()) {
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifi = true;
      }
      if (!wifi) {
        state("Connect this phone to Wi-Fi");
        return;
      }
      if (Settings.Global.getInt(getContentResolver(), "adb_wifi_enabled", 0) == 0) {
        if (checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
            != PackageManager.PERMISSION_GRANTED) {
          state("Turn on Wireless debugging in Android settings");
          return;
        }
        if (enableAttempts < 3) {
          enableAttempts++;
          Settings.Global.putInt(getContentResolver(), "adb_wifi_enabled", 1);
        }
        state("Approve Android’s Wireless debugging dialog if shown");
      }
      try (LocalDiscovery discovery = new LocalDiscovery(this, "_adb-tls-connect._tcp.");
          Identity adb = new Identity(this)) {
        activeAdb = adb;
        state("Connecting · approve Android’s dialog if shown");
        adb.setTimeout(8, TimeUnit.SECONDS);
        if (!adb.connect("127.0.0.1", discovery.await(12))) throw new IllegalStateException();
        if (!Broker.shell(adb, "id -u").equals("2000")) throw new SecurityException();
        if (closed) return;
        if (checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
            != PackageManager.PERMISSION_GRANTED) {
          Broker.shell(
              adb, "pm grant " + getPackageName() + " android.permission.WRITE_SECURE_SETTINGS");
          if (checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
              != PackageManager.PERMISSION_GRANTED) throw new SecurityException();
        }
        Broker.start(this, adb, epoch);
        if (closed) return;
        Store.ready = true;
        hadReady = true;
        state("Ready · advanced taps and swipes");
      }
    } catch (Exception e) {
      if (!closed) state("Not ready · approve Android’s dialog, or pair again in Android settings");
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int id) {
    if (intent != null && "stop".equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (intent != null && intent.hasExtra("code")) {
      String code = intent.getStringExtra("code");
      if (code != null && code.matches("[0-9]{6}") && !AdvancedControl.paired(this))
        worker.execute(
            () -> {
              try (LocalDiscovery discovery = new LocalDiscovery(this, "_adb-tls-pairing._tcp.");
                  Identity adb = new Identity(this)) {
                activeAdb = adb;
                state("Pairing on this phone");
                adb.setTimeout(8, TimeUnit.SECONDS);
                if (!adb.pair("127.0.0.1", discovery.await(20), code))
                  throw new SecurityException();
                if (!closed) {
                  Store.prefs(this).edit().putBoolean("paired", true).apply();
                  state("Paired · connecting");
                }
              } catch (Exception e) {
                state("Pairing failed · request a new Android pairing code");
              }
            });
    }
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    closed = true;
    worker.shutdownNow();
    Identity closing = activeAdb;
    if (closing != null)
      new Thread(
              () -> {
                try {
                  closing.close();
                } catch (Exception ignored) {
                }
              },
              "advanced-cancel")
          .start();
    Store.Capability capability = Store.capability;
    Store.clear();
    new Thread(
            () -> {
              if (capability != null)
                try {
                  Broker.call(capability, new JSONObject().put("op", "stop"));
                } catch (Exception ignored) {
                }
            },
            "advanced-stop")
        .start();
    Store.phase = "Off";
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}

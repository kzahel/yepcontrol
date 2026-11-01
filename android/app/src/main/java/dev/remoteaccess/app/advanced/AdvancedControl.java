// SPDX-License-Identifier: MIT
package dev.remoteaccess.app.advanced;

import android.content.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Public integration surface. No generic shell or automatic boot start. */
public final class AdvancedControl {
  private AdvancedControl() {}

  public static JSONObject report(Context c) throws org.json.JSONException {
    boolean ready = ready();
    return new JSONObject()
        .put("paired", paired(c) || ready)
        .put("running", running() || ready)
        .put("ready", ready);
  }

  public static boolean paired(Context c) {
    return Store.prefs(c).getBoolean("paired", false);
  }

  public static boolean ready() {
    return Store.running && Store.ready;
  }

  public static boolean running() {
    return Store.running;
  }

  public static String state() {
    return Store.phase;
  }

  public static void start(Context c) {
    c.startForegroundService(new Intent(c, AdvancedService.class));
  }

  public static void stop(Context c) {
    Store.ready = false;
    c.stopService(new Intent(c, AdvancedService.class));
  }

  public static void forget(Context c) throws Exception {
    if (Store.running) throw new IllegalStateException("Stop advanced control first");
    Vault.forget(c);
    Store.prefs(c).edit().clear().apply();
  }

  /** Called only after normal controller, scene, keyguard and settings policy checks. */
  public static void touch(Context c, JSONObject packet) throws Exception {
    if (!ready()) throw new IllegalStateException("Advanced control is unavailable");
    Broker.call(c, packet.put("op", "touch"));
  }

  public static void cancel(Context c) {
    if (!Store.running) return;
    try {
      Broker.call(c, new JSONObject().put("op", "cancel"));
    } catch (Exception ignored) {
    }
  }
}

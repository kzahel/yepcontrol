// SPDX-License-Identifier: MIT
package dev.remoteaccess.app.advanced;

import android.content.*;
import java.io.IOException;

/** Helper capabilities and attestation never survive process death or reboot. */
final class Store {
  static volatile boolean running;
  static volatile boolean ready;
  private static volatile boolean cancelled = true;

  static final class Capability {
    final int port;
    final String token;
    final String epoch;
    volatile int pid;
    volatile int uid = -1;

    Capability(int port, String token, String epoch) {
      this.port = port;
      this.token = token;
      this.epoch = epoch;
    }
  }

  static volatile Capability capability;
  static volatile String epoch = "";
  static volatile String phase = "Off";

  static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences("advanced", Context.MODE_PRIVATE);
  }

  static boolean enabled(Context c) {
    return running && !cancelled;
  }

  static boolean current(String expected) {
    return running && !cancelled && epoch.equals(expected);
  }

  static synchronized void begin(String value) {
    ready = false;
    capability = null;
    epoch = value;
    cancelled = false;
    running = true;
    phase = "Starting";
  }

  static synchronized Capability install(int port, String token, String expected)
      throws IOException {
    if (!current(expected)) throw new IOException("Start cancelled");
    Capability value = new Capability(port, token, expected);
    capability = value;
    return value;
  }

  static synchronized void markReady(String expected) throws IOException {
    if (!current(expected)
        || capability == null
        || !capability.epoch.equals(expected)
        || capability.uid != 2000
        || capability.pid <= 0) throw new IOException("Start cancelled");
    ready = true;
  }

  static synchronized void unready(String expected) {
    if (epoch.equals(expected)) ready = false;
  }

  static synchronized void cancel() {
    cancelled = true;
    ready = false;
  }

  static synchronized Capability end(String expected) {
    if (!epoch.equals(expected)) return null;
    Capability previous = capability;
    cancel();
    running = false;
    capability = null;
    phase = "Off";
    return previous;
  }

  static synchronized void paired(Context c, String expected) throws IOException {
    if (!current(expected)) throw new IOException("Start cancelled");
    prefs(c).edit().putBoolean("paired", true).apply();
  }
}

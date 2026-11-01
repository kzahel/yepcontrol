// SPDX-License-Identifier: MIT
package dev.remoteaccess.app.advanced;

import android.content.*;

/** Helper capabilities and attestation never survive process death or reboot. */
final class Store {
  static volatile boolean running;
  static volatile boolean ready;

  static final class Capability {
    final int port;
    final String token;
    volatile int pid;
    volatile int uid = -1;

    Capability(int port, String token) {
      this.port = port;
      this.token = token;
    }
  }

  static volatile Capability capability;
  static volatile String epoch = "";
  static volatile String phase = "Off";

  static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences("advanced", Context.MODE_PRIVATE);
  }

  static boolean enabled(Context c) {
    return running;
  }

  static void clear() {
    ready = false;
    running = false;
    capability = null;
  }
}

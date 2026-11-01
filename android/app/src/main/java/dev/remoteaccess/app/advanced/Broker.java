package dev.remoteaccess.app.advanced;

import android.content.Context;
import io.github.muntashirakon.adb.AdbStream;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class Broker {
  static JSONObject call(Context c, JSONObject request) throws Exception {
    if (!Store.running) throw new IOException("Advanced control is off");
    Store.Capability capability = Store.capability;
    if (capability == null) throw new IOException("No helper");
    return call(capability, request);
  }

  static JSONObject call(Store.Capability capability, JSONObject request) throws Exception {
    int port = capability.port;
    String key = capability.token;
    try (Socket socket = new Socket()) {
      socket.connect(new InetSocketAddress("127.0.0.1", port), 1500);
      socket.setSoTimeout(5000);
      DataInputStream in = new DataInputStream(socket.getInputStream());
      DataOutputStream out = new DataOutputStream(socket.getOutputStream());
      String server = Wire.read(in), client = Wire.random(), body = request.toString();
      String prefix = server + "\n" + client + "\n";
      Wire.write(out, client);
      Wire.write(out, body);
      Wire.write(out, Wire.mac(key, "client\n" + prefix + body));
      String result = Wire.read(in);
      Wire.verify(Wire.read(in), Wire.mac(key, "server\n" + prefix + result));
      JSONObject value = new JSONObject(result);
      if (capability.uid != 2000 || value.optInt("pid", -1) != capability.pid)
        throw new SecurityException("Helper has no matching OS shell attestation");
      if (value.has("error")) throw new IOException(value.getString("error"));
      return value;
    }
  }

  static String exchange(Identity adb, String command, byte[] input) throws Exception {
    String marker = "YEP_" + java.util.UUID.randomUUID() + ":";
    try (AdbStream stream =
        adb.openStream("shell:" + command + "; printf '\\n" + marker + "%s\\n' \"$?\"")) {
      java.util.Timer deadline = new java.util.Timer("adb-command-deadline", true);
      deadline.schedule(
          new java.util.TimerTask() {
            public void run() {
              try {
                stream.close();
              } catch (Exception ignored) {
              }
            }
          },
          10000);
      try {
        if (input != null) stream.openOutputStream().write(input);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        InputStream in = stream.openInputStream();
        for (; ; ) {
          int n = in.read(buffer);
          if (n < 0) throw new IOException("Command ended without completion marker");
          if (out.size() + n > 65536) throw new IOException("Command output too large");
          out.write(buffer, 0, n);
          String result = new String(out.toByteArray(), StandardCharsets.UTF_8);
          int at = result.lastIndexOf("\n" + marker);
          if (at != -1 && result.endsWith("\n")) {
            if (!result.substring(at + marker.length() + 1).trim().equals("0"))
              throw new IOException("Phone-local shell command failed");
            return result.substring(0, at).trim();
          }
        }
      } finally {
        deadline.cancel();
      }
    }
  }

  static String shell(Identity adb, String command) throws Exception {
    return exchange(adb, command, null);
  }

  static String quote(String s) {
    return "'" + s.replace("'", "'\\''") + "'";
  }

  static void start(Context c, Identity adb, String epoch) throws Exception {
    int port;
    try (ServerSocket reserve = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
      port = reserve.getLocalPort();
    }
    String key = Wire.random();
    String path = "/data/local/tmp/yep-local-" + java.util.UUID.randomUUID() + ".json";
    JSONObject bootstrap =
        new JSONObject()
            .put("port", port)
            .put("token", key)
            .put("authority", c.getPackageName() + ".bootstrap");
    // Token travels through the already paired encrypted stream, never argv or diagnostics.
    byte[] bytes = bootstrap.toString().getBytes(StandardCharsets.UTF_8);
    try {
      exchange(adb, "umask 077; head -c " + bytes.length + " > " + quote(path), bytes);
      if (!Store.running || !Store.epoch.equals(epoch)) throw new IOException("Start cancelled");
      Store.capability = new Store.Capability(port, key);
      String cmd =
          "CLASSPATH="
              + quote(c.getApplicationInfo().sourceDir)
              + " setsid nohup app_process / dev.remoteaccess.app.advanced.ShellHelper "
              + quote(path)
              + " </dev/null >/dev/null 2>&1 & sleep 1";
      shell(adb, cmd);
      Exception last = null;
      for (int i = 0; i < 30; i++) {
        try {
          JSONObject pong = call(c, new JSONObject().put("op", "ping"));
          if (pong.getInt("uid") != 2000) throw new SecurityException("Helper is not shell UID");

          return;
        } catch (Exception e) {
          last = e;
          Thread.sleep(250);
        }
      }
      throw last;
    } finally {
      try {
        shell(adb, "rm -f " + quote(path));
      } catch (Exception ignored) {
      }
    }
  }
}

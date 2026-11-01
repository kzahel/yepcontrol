package com.yepcontrol.adbspike;

import android.content.Context;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import io.github.muntashirakon.adb.AdbStream;
import org.json.JSONObject;

final class Broker {
    static JSONObject call(Context c, JSONObject request) throws Exception {
        int port = Store.prefs(c).getInt("port", 0);
        String key = Store.prefs(c).getString("token", "");
        if (port == 0 || key.isEmpty()) throw new IOException("No helper");
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 1500); socket.setSoTimeout(5000);
            DataInputStream in = new DataInputStream(socket.getInputStream());
            DataOutputStream out = new DataOutputStream(socket.getOutputStream());
            String server = Wire.read(in), client = Wire.random(), body = request.toString();
            String prefix = server + "\n" + client + "\n";
            Wire.write(out, client); Wire.write(out, body); Wire.write(out, Wire.mac(key, "client\n" + prefix + body));
            String result = Wire.read(in); Wire.verify(Wire.read(in), Wire.mac(key, "server\n" + prefix + result));
            JSONObject value = new JSONObject(result);
            if (Store.prefs(c).getInt("attestedUid", -1) != 2000 || value.optInt("pid", -1) != Store.prefs(c).getInt("attestedPid", 0)) throw new SecurityException("Helper has no matching OS shell attestation");
            if (value.has("error")) throw new IOException(value.getString("error"));
            return value;
        }
    }
    static String exchange(Identity adb, String command, byte[] input) throws Exception {
        String marker = "YEP_" + java.util.UUID.randomUUID() + ":";
        try (AdbStream stream = adb.openStream("shell:" + command + "; printf '\\n" + marker + "%s\\n' \"$?\"")) {
            java.util.Timer deadline = new java.util.Timer("adb-command-deadline", true);
            deadline.schedule(new java.util.TimerTask() { public void run() { try { stream.close(); } catch (Exception ignored) {} } }, 10000);
            try {
                if (input != null) stream.openOutputStream().write(input);
                ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
                InputStream in = stream.openInputStream();
                for (;;) {
                    int n = in.read(buffer);
                    if (n < 0) throw new IOException("Command ended without completion marker");
                    if (out.size() + n > 65536) throw new IOException("Command output too large");
                    out.write(buffer, 0, n);
                    String result = new String(out.toByteArray(), StandardCharsets.UTF_8);
                    int at = result.lastIndexOf("\n" + marker);
                    if (at != -1 && result.endsWith("\n")) {
                        if (!result.substring(at + marker.length() + 1).trim().equals("0")) throw new IOException("Phone-local shell command failed");
                        return result.substring(0, at).trim();
                    }
                }
            } finally { deadline.cancel(); }
        }
    }
    static String shell(Identity adb, String command) throws Exception { return exchange(adb, command, null); }
    static String quote(String s) { return "'" + s.replace("'", "'\\''") + "'"; }
    static void start(Context c, Identity adb) throws Exception {
        int port;
        try (ServerSocket reserve = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { port = reserve.getLocalPort(); }
        String key = Wire.random();
        String path = "/data/local/tmp/yep-local-" + java.util.UUID.randomUUID() + ".json";
        JSONObject bootstrap = new JSONObject().put("port", port).put("token", key).put("authority", c.getPackageName() + ".bootstrap");
        // Token travels through the already paired encrypted stream, never argv or diagnostics.
        byte[] bytes = bootstrap.toString().getBytes(StandardCharsets.UTF_8);
        exchange(adb, "umask 077; head -c " + bytes.length + " > " + quote(path), bytes);
        Store.prefs(c).edit().putInt("port", port).putString("token", key).putInt("attestedPid", 0).putInt("attestedUid", -1).commit();
        String cmd = "CLASSPATH=" + quote(c.getApplicationInfo().sourceDir)
            + " setsid nohup app_process / com.yepcontrol.adbspike.ShellHelper " + quote(path) + " </dev/null >/data/local/tmp/yep-local-helper.log 2>&1 & sleep 1";
        try {
        shell(adb, cmd);
        Exception last = null;
        for (int i = 0; i < 30; i++) {
            try {
                JSONObject pong = call(c, new JSONObject().put("op", "ping"));
                if (pong.getInt("uid") != 2000) throw new SecurityException("Helper is not shell UID");
                Store.prefs(c).edit().putInt("helperPid", pong.getInt("pid")).putInt("helperUid", pong.getInt("uid")).commit();
                return;
            } catch (Exception e) { last = e; Thread.sleep(250); }
        }
        throw last;
        } finally {
            try { shell(adb, "rm -f " + quote(path)); } catch (Exception ignored) {}
        }
    }
}

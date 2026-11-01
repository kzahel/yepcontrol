package dev.remoteaccess.app.advanced;

import android.os.*;
import android.view.*;
import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.file.Files;
import org.json.*;

/** Shell UID process. No shell-command operation is exposed to clients. */
@android.annotation.SuppressLint("PrivateApi") // Executed only by the OS-authenticated shell UID.
public final class ShellHelper {
  public static void main(String[] args) throws Exception {
    if (android.os.Process.myUid() != 2000 || args.length != 1) throw new SecurityException();
    File configFile = new File(args[0]);
    JSONObject config =
        new JSONObject(
            new String(
                Files.readAllBytes(configFile.toPath()), java.nio.charset.StandardCharsets.UTF_8));
    if (!configFile.delete()) throw new IOException("Bootstrap cleanup failed");
    Looper.prepareMainLooper();
    String key = config.getString("token");
    RawInput input = new RawInput();
    long lease = SystemClock.elapsedRealtime();
    try (ServerSocket server =
        new ServerSocket(config.getInt("port"), 2, InetAddress.getByName("127.0.0.1"))) {
      server.setSoTimeout(100);
      attest(config);
      boolean running = true;
      while (running && SystemClock.elapsedRealtime() - lease < 30000) {
        input.idle();
        try (Socket socket = server.accept()) {
          socket.setSoTimeout(200);
          DataInputStream in = new DataInputStream(socket.getInputStream());
          DataOutputStream out = new DataOutputStream(socket.getOutputStream());
          String nonce = Wire.random();
          Wire.write(out, nonce);
          String client = Wire.read(in),
              body = Wire.read(in),
              prefix = nonce + "\n" + client + "\n";
          Wire.verify(Wire.read(in), Wire.mac(key, "client\n" + prefix + body));
          lease = SystemClock.elapsedRealtime();
          JSONObject response;
          try {
            JSONObject request = new JSONObject(body);
            String op = request.getString("op");
            response =
                new JSONObject()
                    .put("pid", android.os.Process.myPid())
                    .put("uid", android.os.Process.myUid());
            switch (op) {
              case "ping":
                break;
              case "stop":
                running = false;
                break;
              case "cancel":
                input.cancel();
                break;
              case "touch":
                input.accept(request);
                response.put("injected", true);
                break;
              default:
                throw new IllegalArgumentException("Unsupported operation");
            }
          } catch (Exception e) {
            response = new JSONObject().put("error", e.getClass().getSimpleName());
          }
          String result = response.toString();
          Wire.write(out, result);
          Wire.write(out, Wire.mac(key, "server\n" + prefix + result));
        } catch (SocketTimeoutException ignored) {
        } catch (Exception ignored) {
          /* Unauthenticated clients cannot extend the lease. */
        }
      }
    }
    input.cancel();
    System.exit(0);
  }

  static void attest(JSONObject config) throws Exception {
    // Same external-provider route as Android's `content` shell command: a shell
    // process is not an ActivityManager-registered Application.
    Class<?> managerType = Class.forName("android.app.IActivityManager");
    Object manager =
        Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
    String authority = config.getString("authority");
    IBinder handle = new Binder();
    Object holder =
        managerType
            .getMethod(
                "getContentProviderExternal", String.class, int.class, IBinder.class, String.class)
            .invoke(manager, authority, 0, handle, "yep-advanced");
    if (holder == null) throw new SecurityException("Bootstrap provider unavailable");
    try {
      Object provider = holder.getClass().getField("provider").get(holder);
      Class<?> providerType = Class.forName("android.content.IContentProvider");
      Bundle proof = new Bundle();
      proof.putString("token", config.getString("token"));
      proof.putInt("port", config.getInt("port"));
      Bundle result;
      if (Build.VERSION.SDK_INT >= 31) {
        android.content.AttributionSource source =
            new android.content.AttributionSource.Builder(android.os.Process.myUid())
                .setPackageName("com.android.shell")
                .build();
        result =
            (Bundle)
                providerType
                    .getMethod(
                        "call",
                        android.content.AttributionSource.class,
                        String.class,
                        String.class,
                        String.class,
                        Bundle.class)
                    .invoke(provider, source, authority, "attest", null, proof);
      } else {
        result =
            (Bundle)
                providerType
                    .getMethod(
                        "call",
                        String.class,
                        String.class,
                        String.class,
                        String.class,
                        String.class,
                        Bundle.class)
                    .invoke(provider, "com.android.shell", null, authority, "attest", null, proof);
      }
      if (result == null || !result.getBoolean("accepted"))
        throw new SecurityException("OS attestation not accepted");
    } finally {
      managerType
          .getMethod("removeContentProviderExternal", String.class, IBinder.class)
          .invoke(manager, authority, handle);
    }
  }
}

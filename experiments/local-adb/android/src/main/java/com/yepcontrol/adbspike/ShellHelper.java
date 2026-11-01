package com.yepcontrol.adbspike;

import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.os.*;
import android.view.*;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.file.Files;
import org.json.*;

/** Shell UID process. No shell-command operation is exposed to clients. */
public final class ShellHelper {
    public static void main(String[] args) throws Exception {
        if (android.os.Process.myUid() != 2000 || args.length != 1) throw new SecurityException();
        File configFile = new File(args[0]);
        JSONObject config = new JSONObject(new String(Files.readAllBytes(configFile.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        if (!configFile.delete()) throw new IOException("Bootstrap cleanup failed");
        Looper.prepareMainLooper();
        String key = config.getString("token");
        long lease = SystemClock.elapsedRealtime();
        try (ServerSocket server = new ServerSocket(config.getInt("port"), 2, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(1000);
            attest(config);
            boolean running = true;
            while (running && SystemClock.elapsedRealtime() - lease < 30000) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(2000);
                    DataInputStream in = new DataInputStream(socket.getInputStream());
                    DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                    String nonce = Wire.random(); Wire.write(out, nonce);
                    String client = Wire.read(in), body = Wire.read(in), prefix = nonce + "\n" + client + "\n";
                    Wire.verify(Wire.read(in), Wire.mac(key, "client\n" + prefix + body));
                    lease = SystemClock.elapsedRealtime();
                    JSONObject response;
                    try {
                        JSONObject request = new JSONObject(body); String op = request.getString("op");
                        response = new JSONObject().put("pid", android.os.Process.myPid()).put("uid", android.os.Process.myUid());
                        switch (op) {
                            case "ping": break;
                            case "stop": running = false; break;
                            case "tap": tap(request.getInt("x"), request.getInt("y")); response.put("injected", true); break;
                            case "sensitivity": response.put("tree", snapshot()); break;
                            default: throw new IllegalArgumentException("Unsupported operation");
                        }
                    } catch (Exception e) { response = new JSONObject().put("error", e.getClass().getSimpleName()); }
                    String result = response.toString();
                    Wire.write(out, result); Wire.write(out, Wire.mac(key, "server\n" + prefix + result));
                } catch (SocketTimeoutException ignored) {
                } catch (Exception ignored) { /* Unauthenticated clients cannot extend the lease. */ }
            }
        }
        System.exit(0);
    }
    static void attest(JSONObject config) throws Exception {
        // Same external-provider route as Android's `content` shell command: a shell
        // process is not an ActivityManager-registered Application.
        Class<?> managerType = Class.forName("android.app.IActivityManager");
        Object manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
        String authority = config.getString("authority"); IBinder handle = new Binder();
        Object holder = managerType.getMethod("getContentProviderExternal", String.class, int.class, IBinder.class, String.class)
            .invoke(manager, authority, 0, handle, "yep-local-spike");
        if (holder == null) throw new SecurityException("Bootstrap provider unavailable");
        try {
            Object provider = holder.getClass().getField("provider").get(holder);
            Class<?> providerType = Class.forName("android.content.IContentProvider");
            Bundle proof = new Bundle(); proof.putString("token", config.getString("token")); proof.putInt("port", config.getInt("port"));
            Bundle result;
            if (Build.VERSION.SDK_INT >= 31) {
                android.content.AttributionSource source = new android.content.AttributionSource.Builder(android.os.Process.myUid()).setPackageName("com.android.shell").build();
                result = (Bundle) providerType.getMethod("call", android.content.AttributionSource.class, String.class, String.class, String.class, Bundle.class)
                    .invoke(provider, source, authority, "attest", null, proof);
            } else {
                result = (Bundle) providerType.getMethod("call", String.class, String.class, String.class, String.class, String.class, Bundle.class)
                    .invoke(provider, "com.android.shell", null, authority, "attest", null, proof);
            }
            if (result == null || !result.getBoolean("accepted")) throw new SecurityException("OS attestation not accepted");
        } finally {
            managerType.getMethod("removeContentProviderExternal", String.class, IBinder.class).invoke(manager, authority, handle);
        }
    }
    static void tap(int x, int y) throws Exception {
        if (x < 0 || y < 0 || x > 20000 || y > 20000) throw new IllegalArgumentException();
        Class<?> klass;
        try { klass = Class.forName("android.hardware.input.InputManagerGlobal"); }
        catch (ClassNotFoundException e) { klass = Class.forName("android.hardware.input.InputManager"); }
        Object manager = klass.getMethod("getInstance").invoke(null);
        Method inject = klass.getMethod("injectInputEvent", InputEvent.class, int.class);
        long down = SystemClock.uptimeMillis();
        for (int action : new int[]{MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP}) {
            MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
            event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try { if (!((Boolean) inject.invoke(manager, event, 2))) throw new IOException("Input injection rejected"); }
            finally { event.recycle(); }
        }
    }
    static JSONObject snapshot() throws Exception {
        HandlerThread callbacks = new HandlerThread("local-automation"); callbacks.start();
        Class<?> connection = Class.forName("android.app.UiAutomationConnection");
        Class<?> iface = Class.forName("android.app.IUiAutomationConnection");
        UiAutomation automation = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, iface)
            .newInstance(callbacks.getLooper(), connection.getConstructor().newInstance());
        try {
            UiAutomation.class.getMethod("connect", int.class).invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            AccessibilityServiceInfo info = automation.getServiceInfo();
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            automation.setServiceInfo(info);
            Thread.sleep(250);
            int[] counts = new int[3]; walk(automation.getRootInActiveWindow(), counts);
            return new JSONObject().put("nodes", counts[0]).put("sensitive", counts[1]).put("clickable", counts[2]);
        } finally {
            try { UiAutomation.class.getMethod("disconnect").invoke(automation); } finally { callbacks.quitSafely(); }
        }
    }
    static void walk(AccessibilityNodeInfo n, int[] counts) {
        if (n == null || counts[0] >= 10000) return;
        counts[0]++; if (Build.VERSION.SDK_INT >= 34 && n.isAccessibilityDataSensitive()) counts[1]++;
        if (n.isClickable()) counts[2]++;
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), counts);
        n.recycle();
    }
}

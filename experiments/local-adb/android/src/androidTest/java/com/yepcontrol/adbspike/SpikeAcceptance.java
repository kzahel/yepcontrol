package com.yepcontrol.adbspike;

import android.app.*;
import android.content.*;
import android.os.*;
import android.provider.Settings;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.*;
import java.util.regex.*;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Phone-side setup. The desktop runner never pairs or grants privileged permissions. */
@RunWith(AndroidJUnit4.class)
public class SpikeAcceptance {
    final Instrumentation inst = InstrumentationRegistry.getInstrumentation();
    final android.content.Context context = inst.getTargetContext();
    UiDevice device;
    interface Checked { boolean get() throws Exception; }
    void await(String label, Checked check) throws Exception {
        long until = SystemClock.elapsedRealtime() + 90000;
        while (SystemClock.elapsedRealtime() < until) { if (check.get()) return; Thread.sleep(500); }
        throw new AssertionError(label);
    }
    JSONObject receipt(String name) throws Exception { return new JSONObject(new String(Files.readAllBytes(new File(context.getNoBackupFilesDir(), name + ".json").toPath()), java.nio.charset.StandardCharsets.UTF_8)); }
    void start(Class<?> activity) throws Exception {
        if (activity == MainActivity.class) {
            // Reliable for both a newly created and an already existing launcher activity.
            // Harness privilege is used only for UI launch, never pairing or permission grants.
            device.executeShellCommand("am start -W -n " + context.getPackageName() + "/.MainActivity");
        } else context.startActivity(new Intent(context, activity).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        device.waitForIdle();
    }
    UiObject2 findText(String text) { return device.wait(Until.findObject(By.text(text)), 5000); }
    void click(String text) { UiObject2 v = findText(text); assertNotNull("Missing UI: " + text, v); v.click(); device.waitForIdle(); }
    void scrollTo(String text) throws Exception {
        for (int i = 0; i < 18; i++) {
            if (device.findObject(By.text(text)) != null) return;
            device.swipe(device.getDisplayWidth()/2, device.getDisplayHeight()*4/5, device.getDisplayWidth()/2, device.getDisplayHeight()/3, 20);
            Thread.sleep(200);
        }
        throw new AssertionError("Missing settings row: " + text);
    }
    @Test public void setupAndProtectedInput() throws Exception {
        setup();
        protectedInput();
    }
    void setup() throws Exception {
        Configurator.getInstance().setUiAutomationFlags(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        device = UiDevice.getInstance(inst); device.wakeUp(); device.pressHome(); device.waitForIdle();
        start(MainActivity.class);
        UiObject2 box = device.wait(Until.findObject(By.res(context.getPackageName(), "automatic")), 15000); assertNotNull("Advanced opt-in checkbox", box); if (box.isChecked()) box.click();
        device.findObject(By.res(context.getPackageName(), "start")).click();
        UiObject2 allow = device.wait(Until.findObject(By.res("com.android.permissioncontroller", "permission_allow_button")), 3000); if (allow != null) allow.click();
        if (Settings.Global.getInt(context.getContentResolver(), Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 0) {
            context.startActivity(new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            device.waitForIdle(); scrollTo("Build number");
            for (int i = 0; i < 7; i++) { device.findObject(By.text("Build number")).click(); Thread.sleep(150); }
        }
        context.startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        device.waitForIdle(); scrollTo("Wireless debugging"); click("Wireless debugging"); Thread.sleep(800); device.waitForIdle();
        // Native user-visible switch; no settings-provider writes from the harness.
        UiObject2 toggle = device.wait(Until.findObject(By.res("com.android.settings", "switch_widget")), 3000);
        if (toggle == null) toggle = device.findObject(By.clazz("android.widget.Switch"));
        assertNotNull("Wireless debugging switch", toggle);
        if (!toggle.isChecked()) toggle.click();
        UiObject2 trust = device.wait(Until.findObject(By.textContains("Always allow on this network")), 3000);
        if (trust != null) { trust.click(); click("Allow"); }
        click("Pair device with pairing code");
        UiObject2 codeView = device.wait(Until.findObject(By.text(Pattern.compile("[0-9]{6}"))), 10000);
        assertNotNull("Native pairing dialog", codeView);
        String code = codeView.getText();
        assertNotNull("Pairing code must be read on the phone", code);
        // Deliver exactly the notification RemoteInput path, without sending the secret to the host.
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        PendingIntent reply = null; RemoteInput[] fields = null;
        for (android.service.notification.StatusBarNotification n : notifications.getActiveNotifications()) {
            if (n.getId() == 1) { reply = n.getNotification().actions[0].actionIntent; fields = n.getNotification().actions[0].getRemoteInputs(); }
        }
        assertNotNull("Pairing notification", reply);
        Intent fill = new Intent(); Bundle answers = new Bundle(); answers.putCharSequence("code", code);
        RemoteInput.addResultsToIntent(fields, fill, answers); reply.send(context, 0, fill); code = null;
        await("App did not pair and start a shell helper", () -> receipt("status").getString("phase").equals("ready"));
        assertEquals("OS-authenticated shell identity", 2000, receipt("status").getInt("attestedUid"));
        Bundle forged = new Bundle(); forged.putString("token", Store.prefs(context).getString("token", "")); forged.putInt("port", Store.prefs(context).getInt("port", 0));
        try {
            context.getContentResolver().call(android.net.Uri.parse("content://" + context.getPackageName() + ".bootstrap"), "attest", null, forged);
            fail("App UID must not attest as shell even when it knows the token");
        } catch (SecurityException expected) { /* OS caller identity is independently required. */ }
        assertFalse("Manual advanced mode must not self-grant restart permission", receipt("status").getBoolean("settingsGrant"));
        int firstHelper = receipt("status").getInt("helperPid");
        start(MainActivity.class);
        box = device.wait(Until.findObject(By.res(context.getPackageName(), "automatic")), 5000); assertNotNull(box); box.click();
        await("Separate automatic-restoration opt-in did not grant permission", () -> receipt("status").getBoolean("settingsGrant") && receipt("status").getString("phase").equals("ready"));
        assertEquals("Enabling restoration must reuse the existing helper", firstHelper, receipt("status").getInt("helperPid"));
        assertTrue("Grant must be delivered by the paired phone-local connection", Store.prefs(context).getBoolean("selfGranted", false));
        assertEquals(2000, receipt("status").getInt("helperUid"));
        // Ordinary comparison service gets normal native accessibility consent.
        context.startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        device.waitForIdle();
        UiObject2 downloaded = device.wait(Until.findObject(By.text("Downloaded apps")), 3000); if (downloaded != null) downloaded.click();
        click("YepControl local ADB spike"); Thread.sleep(800); device.waitForIdle();
        UiObject2 use = device.wait(Until.findObject(By.res("com.android.settings", "switch_widget")), 3000);
        if (use == null) use = device.findObject(By.clazz("android.widget.Switch"));
        assertNotNull("Accessibility switch", use);
        if (use.isChecked() && ComparisonService.instance == null) {
            use.click(); Thread.sleep(500);
            UiObject2 stop = device.findObject(By.text("Stop")); if (stop != null) stop.click();
            Thread.sleep(500);
            use = device.findObject(By.res("com.android.settings", "switch_widget"));
            if (use == null) use = device.findObject(By.clazz("android.widget.Switch"));
        }
        if (!use.isChecked()) use.click();
        UiObject2 consent = device.wait(Until.findObject(By.text("Allow")), 3000); if (consent != null) consent.click();
        await("Comparison service not enabled", () -> ComparisonService.instance != null);
        Store.receipt(context, "setup", new JSONObject().put("phoneLocalPairing", true).put("phoneLocalGrant", true).put("uiConsent", true).put("appUidCannotAttest", true));
    }
    void protectedInput() throws Exception {
        // Ordinary service only. Helper snapshots run after instrumentation releases UiAutomation.
        start(ProtectedActivity.class);
        Thread.sleep(1000);
        await("Comparison service missing", () -> ComparisonService.instance != null);
        JSONObject before = receipt("fixture"); int x = before.getInt("x"), y = before.getInt("y"), count = before.getInt("count");
        CompletableFuture<String> completion = new CompletableFuture<>();
        inst.runOnMainSync(() -> ComparisonService.instance.tap(x, y, completion::complete));
        assertEquals("completed", completion.get(10, TimeUnit.SECONDS)); Thread.sleep(500);
        assertEquals("Ordinary accessibility tap unexpectedly reached protected target", count, receipt("fixture").getInt("count"));
        Store.receipt(context, "ordinary-input", new JSONObject().put("gestureCallback", "completed").put("ordinaryTapDelivered", false).put("count", count));
    }
}

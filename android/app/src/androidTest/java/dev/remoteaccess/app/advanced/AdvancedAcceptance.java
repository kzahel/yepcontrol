package dev.remoteaccess.app.advanced;

import static org.junit.Assert.*;

import android.app.*;
import android.content.*;
import android.os.*;
import android.provider.Settings;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import dev.remoteaccess.app.MainActivity;
import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.*;
import java.util.regex.*;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;

/** Phone-side setup. The desktop runner never pairs or grants privileged permissions. */
@RunWith(AndroidJUnit4.class)
public class AdvancedAcceptance {
  final Instrumentation inst = InstrumentationRegistry.getInstrumentation();
  final android.content.Context context = inst.getTargetContext();
  UiDevice device;

  interface Checked {
    boolean get() throws Exception;
  }

  void await(String label, Checked check) throws Exception {
    long until = SystemClock.elapsedRealtime() + 90000;
    while (SystemClock.elapsedRealtime() < until) {
      if (check.get()) return;
      Thread.sleep(500);
    }
    throw new AssertionError(label + " (" + AdvancedControl.state() + ")");
  }

  JSONObject receipt(String name) throws Exception {
    return new JSONObject(
        new String(
            Files.readAllBytes(new File(context.getNoBackupFilesDir(), name + ".json").toPath()),
            java.nio.charset.StandardCharsets.UTF_8));
  }

  void start(Class<?> activity) throws Exception {
    if (activity == MainActivity.class) {
      // Reliable for both a newly created and an already existing launcher activity.
      // Harness privilege is used only for UI launch, never pairing or permission grants.
      device.executeShellCommand(
          "am start -W -f 0x14000000 -n "
              + context.getPackageName()
              + "/dev.remoteaccess.app.MainActivity");
    } else
      context.startActivity(new Intent(context, activity).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    device.waitForIdle();
  }

  UiObject2 findText(String text) {
    return device.wait(Until.findObject(By.text(text)), 5000);
  }

  void click(String text) {
    UiObject2 v = findText(text);
    assertNotNull("Missing UI: " + text, v);
    v.click();
    device.waitForIdle();
  }

  void scrollTo(String text) throws Exception {
    for (int i = 0; i < 18; i++) {
      if (device.findObject(By.text(text)) != null) return;
      device.swipe(
          device.getDisplayWidth() / 2,
          device.getDisplayHeight() * 4 / 5,
          device.getDisplayWidth() / 2,
          device.getDisplayHeight() / 3,
          20);
      Thread.sleep(200);
    }
    throw new AssertionError("Missing settings row: " + text);
  }

  void advancedPage() throws Exception {
    start(MainActivity.class);
    if (device.findObject(By.res(context.getPackageName(), "advanced_status")) != null) return;
    UiObject2 menu = device.wait(Until.findObject(By.desc("Open navigation")), 5000);
    if (menu != null) {
      menu.click();
      click("Settings");
    }
    for (int i = 0; i < 18; i++) {
      UiObject2 row = device.findObject(By.res(context.getPackageName(), "advanced_settings"));
      if (row != null) {
        row.click();
        return;
      }
      device.swipe(
          device.getDisplayWidth() / 2,
          device.getDisplayHeight() * 4 / 5,
          device.getDisplayWidth() / 2,
          device.getDisplayHeight() / 3,
          20);
      Thread.sleep(200);
    }
    fail("Missing Advanced control settings row");
  }

  @After
  public void saveUi() throws Exception {
    if (device != null)
      device.dumpWindowHierarchy(new File(context.getNoBackupFilesDir(), "advanced-test-ui.xml"));
  }

  @Test
  public void setupOnPhone() throws Exception {
    Configurator.getInstance()
        .setUiAutomationFlags(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    device = UiDevice.getInstance(inst);
    device.wakeUp();
    device.pressHome();
    device.waitForIdle();
    assertFalse("No implicit start", AdvancedControl.running());
    assertFalse("Initially unpaired", AdvancedControl.paired(context));
    advancedPage();
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (!manager.areNotificationsEnabled()) {
      scrollTo("Allow setup notifications");
      click("Allow setup notifications");
      UiObject2 allow =
          device.wait(
              Until.findObject(
                  By.res("com.android.permissioncontroller", "permission_allow_button")),
              5000);
      assertNotNull("Native notification permission", allow);
      allow.click();
      await("Notification consent did not complete", () -> manager.areNotificationsEnabled());
    }
    scrollTo("Set up advanced control");
    click("Set up advanced control");
    UiObject2 confirm = device.wait(Until.findObject(By.res("android", "button1")), 5000);
    assertNotNull("Setup confirmation", confirm);
    confirm.click();
    await("Service did not start", () -> AdvancedControl.running());
    if (Settings.Global.getInt(
            context.getContentResolver(), Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0)
        == 0) {
      context.startActivity(
          new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      device.waitForIdle();
      scrollTo("Build number");
      for (int i = 0; i < 7; i++) {
        device.findObject(By.text("Build number")).click();
        Thread.sleep(150);
      }
    }
    context.startActivity(
        new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    device.waitForIdle();
    scrollTo("Wireless debugging");
    click("Wireless debugging");
    Thread.sleep(800);
    device.waitForIdle();
    // Native user-visible switch; no settings-provider writes from the harness.
    UiObject2 toggle =
        device.wait(Until.findObject(By.res("com.android.settings", "switch_widget")), 3000);
    if (toggle == null) toggle = device.findObject(By.clazz("android.widget.Switch"));
    assertNotNull("Wireless debugging switch", toggle);
    if (!toggle.isChecked()) toggle.click();
    UiObject2 trust =
        device.wait(Until.findObject(By.textContains("Always allow on this network")), 3000);
    if (trust != null) {
      trust.click();
      click("Allow");
    }
    click("Pair device with pairing code");
    UiObject2 codeView = device.wait(Until.findObject(By.text(Pattern.compile("[0-9]{6}"))), 10000);
    assertNotNull("Native pairing dialog", codeView);
    String code = codeView.getText();
    assertNotNull("Pairing code must be read on the phone", code);
    // Deliver exactly the notification RemoteInput path, without sending the secret to the host.
    NotificationManager notifications = context.getSystemService(NotificationManager.class);
    PendingIntent reply = null;
    RemoteInput[] fields = null;
    for (android.service.notification.StatusBarNotification n :
        notifications.getActiveNotifications()) {
      if (n.getId() == 47) {
        for (Notification.Action action : n.getNotification().actions) {
          if (action.getRemoteInputs() != null) {
            reply = action.actionIntent;
            fields = action.getRemoteInputs();
          }
        }
      }
    }
    assertNotNull("Pairing notification", reply);
    Intent fill = new Intent();
    Bundle answers = new Bundle();
    answers.putCharSequence("code", code);
    RemoteInput.addResultsToIntent(fields, fill, answers);
    reply.send(context, 0, fill);
    code = null;
    await("App did not authenticate a shell helper", () -> AdvancedControl.ready());
    assertEquals(2000, Store.capability.uid);
    assertTrue(
        context.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
            == android.content.pm.PackageManager.PERMISSION_GRANTED);
    Bundle forged = new Bundle();
    forged.putString("token", Store.capability.token);
    forged.putInt("port", Store.capability.port);
    try {
      context
          .getContentResolver()
          .call(
              android.net.Uri.parse("content://" + context.getPackageName() + ".bootstrap"),
              "attest",
              null,
              forged);
      fail("App UID must not attest as shell");
    } catch (SecurityException expected) {
    }
    // Input validation exercises the real helper, never a desktop shell input command.
    context.startActivity(
        new Intent(context, ProtectedFixture.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    await("Protected fixture did not show", () -> ProtectedFixture.x > 0);
    int before = ProtectedFixture.count;
    JSONObject packet =
        new JSONObject()
            .put("owner", "acceptance")
            .put("sequence", 0)
            .put("scene", 1)
            .put("gesture", 1)
            .put("duration", 50)
            .put(
                "contacts",
                new org.json.JSONArray()
                    .put(
                        new JSONObject()
                            .put("id", 0)
                            .put("held", false)
                            .put(
                                "path",
                                new org.json.JSONArray()
                                    .put(
                                        new org.json.JSONArray()
                                            .put(ProtectedFixture.x)
                                            .put(ProtectedFixture.y)))));
    AdvancedControl.touch(context, packet);
    await("Protected counter did not receive input", () -> ProtectedFixture.count == before + 1);
    int afterTap = ProtectedFixture.count;
    JSONObject held = new JSONObject(packet.toString()).put("owner", "held-pointers");
    org.json.JSONArray heldContacts = held.getJSONArray("contacts");
    heldContacts.getJSONObject(0).put("held", true);
    heldContacts.put(new JSONObject(heldContacts.getJSONObject(0).toString()).put("id", 1));
    AdvancedControl.touch(context, held);
    Thread.sleep(1100);
    assertEquals(
        "Expired held input must cancel without a click", afterTap, ProtectedFixture.count);
    try {
      AdvancedControl.touch(context, new JSONObject(held.toString()).put("sequence", 1));
      fail("Expired contact continuation must be refused");
    } catch (java.io.IOException | SecurityException expected) {
    }
    AdvancedControl.touch(context, new JSONObject(packet.toString()).put("owner", "after-cancel"));
    await("Fresh input after cancellation failed", () -> ProtectedFixture.count == afterTap + 1);
    byte[] identity =
        Files.readAllBytes(new File(context.getNoBackupFilesDir(), "advanced-identity").toPath());
    assertFalse(
        "Private identity must be wrapped",
        new String(identity, java.nio.charset.StandardCharsets.UTF_8).contains("certificate"));
    advancedPage();
    assertFalse(
        "Paired Start/Stop remains remotely accessible",
        dev.remoteaccess.app.control.LocalSettingsProtection.INSTANCE.getBlocked());
    for (int i = 0; i < 18; i++) {
      UiObject2 setup = device.findObject(By.res(context.getPackageName(), "advanced_setup"));
      if (setup != null) {
        setup.click();
        break;
      }
      device.swipe(
          device.getDisplayWidth() / 2,
          device.getDisplayHeight() * 4 / 5,
          device.getDisplayWidth() / 2,
          device.getDisplayHeight() / 3,
          20);
    }
    await(
        "Pairing configuration must remain protected",
        () -> dev.remoteaccess.app.control.LocalSettingsProtection.INSTANCE.getBlocked());
    device.pressBack();
    await(
        "Runtime controls remained protected",
        () -> !dev.remoteaccess.app.control.LocalSettingsProtection.INSTANCE.getBlocked());
    Store.Capability stopped = Store.capability;
    scrollTo("Stop advanced control");
    click("Stop advanced control");
    await(
        "Stop did not revoke readiness",
        () -> !AdvancedControl.ready() && !AdvancedControl.running());
    assertTrue(AdvancedControl.paired(context));
    await(
        "Stopped helper is still accepting authenticated input",
        () -> {
          try {
            Broker.call(stopped, new JSONObject().put("op", "ping"));
            return false;
          } catch (Exception expected) {
            return true;
          }
        });
  }

  @Test
  public void staleStartCannotPublishReadiness() throws Exception {
    Store.begin("first");
    Store.Capability first = Store.install(32123, "test-only", "first");
    first.uid = 2000;
    first.pid = 1;
    Store.markReady("first");
    assertTrue(AdvancedControl.ready());
    Store.cancel();
    assertFalse(AdvancedControl.ready());
    try {
      Store.markReady("first");
      fail("Cancelled start revived readiness");
    } catch (java.io.IOException expected) {
    }
    Store.end("first");
    Store.begin("replacement");
    try {
      Store.install(32124, "test-only", "first");
      fail("Stale bootstrap replaced current capability");
    } catch (java.io.IOException expected) {
    }
    Store.Capability replacement = Store.install(32125, "test-only", "replacement");
    replacement.uid = 2000;
    replacement.pid = 2;
    try {
      Store.markReady("first");
      fail("Stale completion revived readiness");
    } catch (java.io.IOException expected) {
    }
    assertFalse(AdvancedControl.ready());
    assertNull(Store.end("first"));
    assertTrue(Store.running);
    Store.markReady("replacement");
    assertTrue(AdvancedControl.ready());
    assertSame(replacement, Store.end("replacement"));
    assertFalse(AdvancedControl.ready());
  }

  @Test
  public void pairingPrimitive() throws Exception {
    byte[] own = "adb pair client\u0000".getBytes(java.nio.charset.StandardCharsets.UTF_8),
        peer = "adb pair server\u0000".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    io.github.muntashirakon.crypto.spake2.Spake2Context alice =
        new io.github.muntashirakon.crypto.spake2.Spake2Context(
            io.github.muntashirakon.crypto.spake2.Spake2Role.Alice, own, peer);
    io.github.muntashirakon.crypto.spake2.Spake2Context bob =
        new io.github.muntashirakon.crypto.spake2.Spake2Context(
            io.github.muntashirakon.crypto.spake2.Spake2Role.Bob, peer, own);
    try {
      byte[] password = new byte[70];
      new java.security.SecureRandom().nextBytes(password);
      byte[] a = alice.generateMessage(password), b = bob.generateMessage(password);
      assertArrayEquals(alice.processMessage(b), bob.processMessage(a));
      try {
        alice.generateMessage(password);
        fail("Must reject reuse");
      } catch (IllegalStateException expected) {
      }
    } finally {
      alice.destroy();
      bob.destroy();
    }
  }
}

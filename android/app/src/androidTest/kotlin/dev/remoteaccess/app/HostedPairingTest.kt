package dev.remoteaccess.app

import android.app.UiAutomation
import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Normal pairing/deep link and native controls, coordinated with isolated real devices. */
@RunWith(AndroidJUnit4::class)
class HostedPairingTest {
    @get:Rule val failureDiagnostics = FixtureFailureDiagnostics()

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val device =
        run {
            Configurator.getInstance().uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        }
    private val store get() = HostStore.get(context).load()

    private fun waitFor(
        timeout: Long = 30000,
        test: () -> Boolean,
    ) {
        val deadline = System.nanoTime() + timeout * 1_000_000
        while (System.nanoTime() < deadline) {
            if (test()) return
            Thread.sleep(100)
        }
        error("Native state did not arrive")
    }

    private fun tap(selector: BySelector) {
        waitFor {
            try {
                device.waitForIdle()
                val view = device.findObject(selector)
                if (view == null || !view.isEnabled) {
                    false
                } else {
                    view.click()
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                    true
                }
            } catch (_: StaleObjectException) {
                false
            }
        }
    }

    private fun click(id: String) {
        if (id in setOf("open_settings", "open_activity", "open_devices")) tap(By.res("${context.packageName}:id/navigation_menu"))
        if (id == "remove_device") {
            // The device detail is taller than lower-density CI viewports. A
            // partially clipped accessibility node is not a reliable tap target.
            val body = UiScrollable(UiSelector().scrollable(true))
            if (body.exists()) body.scrollToEnd(5)
            device.waitForIdle()
        }
        val selector = By.res("${context.packageName}:id/$id")
        if (id == "grant_device") {
            // A stale accessibility node can report a click without invoking
            // the button. Confirm that approval started before waiting for the
            // network result. Once started, the app removes the button and its
            // granting guard prevents a second enrollment operation.
            waitFor {
                if (!device.hasObject(selector)) {
                    true
                } else {
                    tap(selector)
                    device.wait(Until.gone(selector), 1500)
                }
            }
        } else {
            tap(selector)
        }
    }

    private fun settings(section: String? = null) {
        start()
        click("open_settings")
        section?.let { click(it) }
    }

    private fun confirmRemoval() {
        val confirm = By.res("android:id/button1")
        // Session-status renders can replace the detail view between scrolling
        // and tapping. Retry only opening the dialog, never its destructive action.
        waitFor {
            if (!device.hasObject(confirm)) click("remove_device")
            device.wait(Until.hasObject(confirm), 2000)
        }
        assertNotNull(device.findObject(confirm)).click()
    }

    private fun openDevice(id: String) {
        start()
        click("open_devices")
        tap(By.descStartsWith(requireNotNull(store.device(id)).nickname + ". "))
    }

    private fun start(uri: String? = null) {
        val intent =
            (
                if (
                    uri != null &&
                    Uri.parse(uri).host == "yepcontrol.com" &&
                    !File(context.filesDir, "hosted-explicit-link-fixture").exists()
                ) {
                    // Exercise Android's verified App Link resolver, as an external camera would.
                    Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addCategory(Intent.CATEGORY_BROWSABLE)
                } else {
                    // Ephemeral CI debug keys cannot verify the public domain. The marker is
                    // written only by the owned-emulator harness; production code never reads it.
                    Intent(context, MainActivity::class.java)
                }
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        if (uri != null) {
            intent.action = Intent.ACTION_VIEW
            intent.data = Uri.parse(uri)
        }
        context.startActivity(intent)
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        val control = if (uri == null) "host_status" else "grant_device"
        assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/$control")), 15000))
    }

    private fun pairedDevice() {
        openDevice(
            store.snapshot.devices
                .first { !it.revoked }
                .id,
        )
    }

    private fun title(expected: String) {
        assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/page_title").text(expected)), 10000))
    }

    @Test
    fun pairOrReconnectAndRevoke() {
        val stage = File(context.filesDir, "hosted-stage")
        val command = File(context.filesDir, "hosted-command")
        val uri = File(context.filesDir, "hosted-pair-uri")
        stage.delete()
        command.delete()
        val pairing = uri.exists()
        start(if (pairing) uri.readText().also { uri.delete() } else null)
        if (pairing) {
            click("grant_device")
            waitFor(90000) { store.snapshot.devices.any { !it.revoked } }
            title("Set up this phone")
            click("skip_features")
        }
        val before = KeystoreIdentity.loadOrCreate("phone-identity-v1").publicKey
        assertTrue(before.contentEquals(KeystoreIdentity.loadOrCreate("phone-identity-v1").publicKey))
        pairedDevice()
        waitFor {
            store.snapshot.devices
                .first()
                .synced
        }
        HostRuntime.connect(
            context,
            store.snapshot.devices
                .first { !it.revoked }
                .id,
        )
        // The viewer may already have completed its canary and retained this
        // exact lease. Do not require an earlier transient status to reappear.
        waitFor {
            HostSessions.current.get()?.let {
                it.active.get() &&
                    it.status in
                    setOf(
                        "Waiting for your device",
                        "Device connected; securing session",
                        "Encrypted session established",
                        "Encrypted connection passed",
                    )
            } == true
        }
        stage.writeText("connected")
        waitFor(120000) { command.exists() }
        when (command.readText()) {
            "wake" -> {
                settings()
                if (!store.snapshot.settings.automatic) click("enable_wake")
                val allow = device.wait(Until.findObject(By.res("com.android.permissioncontroller:id/permission_allow_button")), 2000)
                allow?.click()
                // Initial Firebase/WorkManager setup on a fresh CI image is separate from
                // the measured process-absent push-delivery deadline.
                waitFor(120000) { store.snapshot.devices.all { it.wakeReady } }
                device.pressHome()
                stage.writeText("wake-ready")
            }
            "revoke" -> {
                confirmRemoval()
                waitFor { store.snapshot.devices.isEmpty() }
                stage.writeText("revoked")
            }
        }
        command.delete()
    }

    /** Management mutations use the real UI; manual transport admission is a fixture-only helper. */
    @Test
    fun manageMultipleDevices() {
        val stage = File(context.filesDir, "hosted-stage")
        val command = File(context.filesDir, "hosted-command")
        val uriFile = File(context.filesDir, "hosted-pair-uri")
        start()
        stage.writeText("ready")
        val deadline = System.nanoTime() + 900_000_000_000L
        while (System.nanoTime() < deadline) {
            if (!command.exists()) {
                Thread.sleep(100)
                continue
            }
            val task = JSONObject(command.readText())
            command.delete()
            val action = task.getString("action")
            val id = task.optString("id")
            when (action) {
                "stop" -> {
                    stage.writeText("stopped")
                    return
                }
                "pair" -> {
                    val before = store.snapshot.devices.size
                    val uri = uriFile.readText()
                    uriFile.delete()
                    start(uri)
                    click("grant_device")
                    waitFor(90000) { store.snapshot.devices.size == before + 1 }
                    waitFor { store.snapshot.devices.all { it.synced } }
                    val paired = store.snapshot.devices.last()
                    if (before == 0) {
                        title("Set up this phone")
                        assertTrue(device.hasObject(By.text("${paired.nickname} is paired.")))
                        assertTrue(device.hasObject(By.res("${context.packageName}:id/screen_access").checked(false)))
                        assertTrue(device.hasObject(By.res("${context.packageName}:id/skip_features").enabled(true)))
                        assertTrue(device.takeScreenshot(File(context.filesDir, "ui-first-pair-setup.png")))
                        // A system-settings round trip may recreate this page before Continue.
                        device.setOrientationLeft()
                        title("Set up this phone")
                        device.setOrientationNatural()
                        title("Set up this phone")
                        click("skip_features")
                    }
                    title(paired.nickname)
                    assertTrue(device.hasObject(By.res("${context.packageName}:id/device_toggle")))
                    assertFalse(device.hasObject(By.res("${context.packageName}:id/skip_features")))
                    assertTrue(
                        device.takeScreenshot(
                            File(context.filesDir, if (before == 0) "ui-first-pair-detail.png" else "ui-next-pair-detail.png"),
                        ),
                    )
                    // A repair action retains this device across recreation and Back.
                    click("open_features")
                    title("Set up this phone")
                    device.setOrientationLeft()
                    title("Set up this phone")
                    device.pressBack()
                    title(paired.nickname)
                    device.setOrientationNatural()
                    title(paired.nickname)
                    device.pressBack()
                    title("This phone")
                    assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/host_status")), 10000))
                    assertFalse(device.hasObject(By.res("${context.packageName}:id/scan_pairing_code")))
                    assertFalse(device.hasObject(By.res("${context.packageName}:id/sharing_website")))
                    click("pair_device")
                    title("Allow a browser")
                    assertTrue(device.hasObject(By.res("${context.packageName}:id/sharing_website")))
                    device.pressBack()
                    title("This phone")
                }
                "home" -> start()
                "control-ready" -> {
                    start()
                    waitFor { dev.remoteaccess.app.control.ScreenAccessService.current != null }
                    waitFor { ForegroundAccess.listening(id) }
                }
                "enable-screen-access" -> {
                    if (dev.remoteaccess.app.control.ScreenAccessService.current == null) {
                        start()
                        settings()
                        click("screen_access")
                        tap(By.res("android:id/button1"))
                        val service = By.text("YepControl")
                        if (!device.wait(Until.hasObject(service), 2000)) {
                            tap(
                                By.text(
                                    java.util.regex.Pattern
                                        .compile("Downloaded apps|Installed apps|Downloaded services"),
                                ),
                            )
                        }
                        tap(service)
                        tap(By.textStartsWith("Use YepControl"))
                        tap(By.text("Allow"))
                        waitFor { dev.remoteaccess.app.control.ScreenAccessService.current != null }
                    }
                    start()
                }
                "rotate" -> {
                    assertTrue(device.executeShellCommand("getprop ro.kernel.qemu").trim() == "1")
                    if (task.getBoolean("landscape")) device.setOrientationLeft() else device.setOrientationNatural()
                }
                "restart-setup" -> {
                    start()
                    settings()
                    if (!RestartRecovery.enabled(context)) click("restore_setup")
                    waitFor { RestartRecovery.enabled(context) }
                }
                "recovery-ready" -> {
                    assertTrue(device.executeShellCommand("getprop ro.kernel.qemu").trim() == "1")
                    assertTrue(RestartRecovery.enabled(context))
                    waitFor(60000) { store.events().any { it.kind == "Setup restored after restart" } }
                    waitFor { dev.remoteaccess.app.control.ScreenAccessService.current != null }
                    val value =
                        dev.remoteaccess.app.unlock
                            .PinVault(context)
                            .read()
                    assertTrue(value.contentEquals("314159".toCharArray()))
                    value.fill('\u0000')
                    waitFor(60000) { store.snapshot.devices.all { it.synced && it.wakeReady } }
                }
                "assert-unlock-blocked" -> {
                    assertTrue(device.executeShellCommand("getprop ro.kernel.qemu").trim() == "1")
                    assertTrue(
                        dev.remoteaccess.app.unlock
                            .PinVault(context)
                            .guard
                            .blocked(),
                    )
                    assertTrue(
                        !dev.remoteaccess.app.unlock
                            .PinVault(context)
                            .saved(),
                    )
                    val extra = if (task.optBoolean("wake")) 1 else 0
                    kotlin.test.assertEquals(3 + extra, store.events().count { it.kind == "Unlock requested" })
                    kotlin.test.assertEquals(2 + extra, store.events().count { it.kind == "Phone unlocked" })
                    // A new vault instance cannot admit a repeat after transport/session replacement.
                    kotlin.test.assertFails {
                        dev.remoteaccess.app.unlock
                            .PinVault(context)
                            .guard
                            .begin()
                    }
                }
                "approve-video" -> {
                    assertTrue(
                        device.executeShellCommand("getprop ro.kernel.qemu").trim() == "1" ||
                            InstrumentationRegistry.getArguments().getString("physicalControl") == "yes",
                    )
                    device.findObject(By.text("A single app"))?.let {
                        it.click()
                        tap(By.text("Entire screen"))
                    }
                    tap(
                        By.text(
                            java.util.regex.Pattern
                                .compile("Start now|Start|Share screen"),
                        ),
                    )
                    waitFor(20000) {
                        dev.remoteaccess.app.control.VideoStream
                            .available(context)
                    }
                }
                "inspect-lock" -> {
                    device.dumpWindowHierarchy(File(context.filesDir, "lock-hierarchy.xml"))
                    val rows = mutableListOf<String>()

                    fun visit(
                        node: android.view.accessibility.AccessibilityNodeInfo?,
                        depth: Int,
                    ) {
                        if (node == null || depth > 30 || rows.size > 600) return
                        rows.add(
                            "${node.viewIdResourceName} visible=${node.isVisibleToUser} enabled=${node.isEnabled} window=${node.windowId}",
                        )
                        repeat(node.childCount) { visit(node.getChild(it), depth + 1) }
                    }
                    dev.remoteaccess.app.control.ScreenAccessService.current
                        ?.windows
                        ?.forEach { visit(it.root, 0) }
                    File(context.filesDir, "service-nodes.txt").writeText(rows.joinToString("\n"))
                }
                "save-fixture-pin" -> {
                    assertTrue(device.executeShellCommand("getprop ro.kernel.qemu").trim() == "1")
                    start()
                    settings()
                    click("saved_pin_settings")
                    click("save_pin")
                    // Disposable emulator credential; never used on a physical phone.
                    val pinField = device.wait(Until.findObject(By.res("${context.packageName}:id/save_pin_value")), 10000)
                    val confirmation = device.wait(Until.findObject(By.res("${context.packageName}:id/save_pin_confirm")), 10000)
                    assertNotNull(pinField).text = "314159"
                    assertNotNull(confirmation).text = "314159"
                    assertNotNull(device.findObject(By.res("android:id/button1"))).click()
                    waitFor {
                        dev.remoteaccess.app.unlock
                            .PinVault(context)
                            .saved()
                    }
                }
                "control-fixture" -> {
                    context.startActivity(
                        Intent()
                            .setClassName("${context.packageName}.test", "dev.remoteaccess.app.ControlFixtureActivity")
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                    )
                    assertTrue(device.wait(Until.hasObject(By.text("Tap witness")), 10000))
                }
                "setup" -> {
                    start()
                    click("pair_device")
                    title("Allow a browser")
                    val scan = assertNotNull(device.wait(Until.findObject(By.res("${context.packageName}:id/scan_pairing_code")), 10000))
                    assertTrue(scan.isEnabled)
                    click("copy_website")
                    val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
                    waitFor {
                        clipboard.primaryClip
                            ?.getItemAt(0)
                            ?.text
                            ?.toString() == "${BuildConfig.SHARING_WEBSITE}/pair"
                    }
                }
                "website-qr" -> click("show_website_qr")
                "share-link" -> {
                    click("share_website")
                    waitFor { device.currentPackageName in setOf("android", "com.android.intentresolver") }
                    device.pressBack()
                }
                "close-setup" -> device.pressBack()
                "features" -> {
                    start()
                    // Pair approval opens the checklist; Settings shows the same switches.
                    settings()
                    assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/screen_access")), 10000))
                }
                "skip-setup" -> start()
                "deny-feature-permission" -> {
                    val paired = store.snapshot.devices.map { it.id }
                    start()
                    settings()
                    click("enable_wake")
                    val deny = By.res("com.android.permissioncontroller:id/permission_deny_button")
                    assertNotNull(device.wait(Until.findObject(deny), 10000)).click()
                    waitFor { store.snapshot.settings.automatic }
                    assertTrue(!WakeSupport.notificationsAllowed(context))
                    start()
                    assertTrue(store.snapshot.devices.map { it.id } == paired)
                }
                "foreground" -> {
                    start()
                    assertTrue(!WakeSupport.notificationsAllowed(context))
                    assertTrue(store.snapshot.settings.automatic == task.optBoolean("automatic", false))
                    waitFor { ForegroundAccess.listening(id) }
                }
                "activity" -> {
                    start()
                    click("open_activity")
                }
                "settings" -> {
                    start()
                    click("open_settings")
                }
                "notification-refresh" -> {
                    start()
                    settings("background_settings")
                    waitFor {
                        device.findObject(By.res("${context.packageName}:id/unused_app_status"))?.text?.let {
                            it != "Checking Android settings…"
                        } == true
                    }
                    click("notification_settings")
                    assertTrue(device.wait(Until.hasObject(By.pkg("com.android.settings")), 10000))
                    device.pressBack()
                    if (device.hasObject(By.res("${context.packageName}:id/unused_app_settings"))) {
                        click("unused_app_settings")
                        assertTrue(device.wait(Until.hasObject(By.pkg("com.android.settings")), 10000))
                        device.pressBack()
                    }
                    // Channel blocking changes real notification authority without killing instrumentation.
                    device.pressHome()
                    val manager = context.getSystemService(android.app.NotificationManager::class.java)
                    val channel = requireNotNull(manager.getNotificationChannel(WakeSupport.CHANNEL))
                    channel.importance = android.app.NotificationManager.IMPORTANCE_NONE
                    manager.createNotificationChannel(channel)
                    assertTrue(!WakeSupport.notificationsAllowed(context))
                    context.startActivity(
                        // Ephemeral CI debug keys cannot verify the public domain. The marker is
                        // written only by the owned-emulator harness; production code never reads it.
                        Intent(context, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    )
                    assertTrue(
                        device.wait(Until.hasObject(By.text("Notifications are off. Turn them on to receive connection requests.")), 15000),
                    )
                    waitFor { store.snapshot.devices.all { !it.wakeReady } }
                    context.startActivity(
                        Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
                            .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, WakeSupport.CHANNEL)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    val channelToggle =
                        assertNotNull(device.wait(Until.findObject(By.pkg("com.android.settings").checkable(true).checked(false)), 10000))
                    channelToggle.click()
                    waitFor { WakeSupport.notificationsAllowed(context) }
                    device.pressBack()
                    assertTrue(device.wait(Until.hasObject(By.text("Notifications are on")), 15000))
                    waitFor { store.snapshot.devices.all { it.wakeReady } }
                }
                "notification-state" -> {
                    start()
                    settings("background_settings")
                    val allowed = task.getBoolean("enabled")
                    assertTrue(WakeSupport.notificationsAllowed(context) == allowed)
                    val message =
                        if (allowed) {
                            "Notifications are on"
                        } else {
                            "Notifications are off. Turn them on to receive connection requests."
                        }
                    assertTrue(device.wait(Until.hasObject(By.text(message)), 15000))
                    waitFor { store.snapshot.devices.all { it.wakeReady == allowed } }
                }
                "global" -> {
                    start()
                    if (store.snapshot.settings.armed != task.getBoolean("enabled")) click("access_toggle")
                    waitFor { store.snapshot.settings.armed == task.getBoolean("enabled") }
                    waitFor { store.snapshot.devices.all { it.synced } }
                }
                "automatic" -> {
                    start()
                    settings()
                    if (store.snapshot.settings.automatic != task.getBoolean("enabled")) click("enable_wake")
                    device.wait(Until.findObject(By.res("com.android.permissioncontroller:id/permission_allow_button")), 2000)?.click()
                    waitFor(60000) {
                        store.snapshot.settings.automatic == task.getBoolean("enabled") &&
                            store.snapshot.devices.all {
                                it.wakeReady == task.getBoolean("enabled")
                            }
                    }
                }
                else -> {
                    start()
                    openDevice(id)
                    when (action) {
                        "details" -> Unit
                        "rename" -> {
                            click("rename_device")
                            val nameField = assertNotNull(device.wait(Until.findObject(By.clazz("android.widget.EditText")), 10000))
                            nameField.text = task.getString("name")
                            assertNotNull(device.findObject(By.res("android:id/button1"))).click()
                            waitFor { store.device(id)?.nickname == task.getString("name") }
                        }
                        "allow-unlock" -> {
                            click("unlock_settings")
                            if (store.device(id)?.unlockAllowed != task.getBoolean("enabled")) click("allow_unlock")
                            waitFor { store.device(id)?.unlockAllowed == task.getBoolean("enabled") }
                            waitFor { store.snapshot.devices.all { it.synced } }
                        }
                        "enable" -> {
                            if (store.device(id)?.enabled != task.getBoolean("enabled")) click("device_toggle")
                            waitFor { store.device(id)?.enabled == task.getBoolean("enabled") && store.device(id)?.synced == true }
                        }
                        "connect" -> {
                            HostRuntime.connect(context, id)
                            waitFor {
                                HostSessions.current.get()?.let { it.deviceId == id && it.status == "Waiting for your device" } == true
                            }
                        }
                        "disconnect" -> {
                            click("disconnect_device")
                            waitFor { HostSessions.current.get() == null }
                        }
                        "remove" -> {
                            confirmRemoval()
                            waitFor { store.device(id) == null }
                        }
                        else -> error("Unknown fixture action")
                    }
                }
            }
            val result =
                JSONObject()
                    .put("action", action)
                    .put(
                        "devices",
                        org.json.JSONArray(
                            store.snapshot.devices.map {
                                JSONObject()
                                    .put(
                                        "id",
                                        it.id,
                                    ).put("nickname", it.nickname)
                                    .put("enabled", it.enabled)
                                    .put("generation", it.generation)
                                    .put("lastConnected", it.lastConnected)
                                    .put("wakeReady", it.wakeReady)
                            },
                        ),
                    ).put("armed", store.snapshot.settings.armed)
                    .put("active", HostSessions.current.get()?.deviceId)
            stage.writeText(result.toString())
        }
        error("Management fixture timed out")
    }

    @Test
    fun revokeFixture() {
        assertTrue(File(context.filesDir, "hosted-stage").exists(), "Not an enrolled acceptance fixture")
        HostSessions.stop()
        androidx.work.WorkManager
            .getInstance(context)
            .cancelAllWork()
        for (pairedDevice in store.snapshot.devices) {
            store.revoke(pairedDevice.id)
            val grant = pairedDevice.authority()
            val signature =
                KeystoreIdentity
                    .loadOrCreate(
                        "phone-identity-v1",
                    ).sign(fields("ara/pair/revoke/v1", grant.getString("origin"), pairedDevice.id))
            request(grant.getString("origin"), pairedDevice.id, "revoke", JSONObject().put("signature", encoded(signature)))
            store.removed(pairedDevice.id)
        }
    }
}

package dev.remoteaccess.app

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Switch
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants
import androidx.core.net.toUri
import androidx.lifecycle.ViewModelProvider
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.MlKitException
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import dev.remoteaccess.app.control.LocalSettingsProtection
import dev.remoteaccess.app.control.ScreenAccessService
import dev.remoteaccess.app.unlock.PinVault
import dev.remoteaccess.app.unlock.UnlockSetup
import java.lang.ref.WeakReference
import java.text.DateFormat
import java.util.Date

/** Plain native management UI. Authority and sessions belong to the application, not this activity. */
class MainActivity : ComponentActivity() {
    private val store by lazy { HostStore.get(this) }
    private val scanner by lazy { ViewModelProvider(this)[PairingScanner::class.java] }
    private val giveControl by lazy { ViewModelProvider(this)[GiveControl::class.java] }
    private val giveListener: () -> Unit = {
        handler.post {
            if (!isDestroyed && loaded) {
                val state = giveControl.state
                if (state.phase == GiveControl.Phase.COMPLETED && state.deviceId != null) {
                    giveControl.consumed()
                    backStack.clear()
                    backStack.add("home")
                    deviceId = state.deviceId
                    page = if (ScreenAccessService.current == null) "features" else "device"
                }
                if (listening) render()
            }
        }
    }
    private var observedScan: PairingScanner.Request? = null
    private lateinit var shell: ManagementShell
    private val backStack = mutableListOf<String>()
    private var page = "home"
    private var deviceId: String? = null
    private var pending: Enrollment? = null

    /** The invitation being granted; cleared by Cancel so a late result does not move the screen. */
    @Volatile private var granting: Enrollment? = null
    private val foregroundOwner = Any()
    private var notice: String? = null
    private var busy = false
    private var changing = false
    private var loaded = false
    private var lastNotificationsAllowed: Boolean? = null
    private var unusedRestrictions: Int? = null
    private var readinessRequest = 0
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            refreshSystemReadiness()
        }
    private val unusedAppSettings =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            refreshSystemReadiness()
        }
    private var listening = false
    private var activityLimit = 200
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = Runnable { if (listening && loaded) render() }
    private val protectionListener: () -> Unit = { if (listening && loaded) render() }
    private val listener: () -> Unit = {
        handler.removeCallbacks(refresh)
        handler.postDelayed(refresh, 150)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(Appearance.theme(this))
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    goBack()
                }
            },
        )
        page = savedInstanceState?.getString("page") ?: "home"
        deviceId = savedInstanceState?.getString("deviceId")
        if (page == "grant") page = "home" // Never persist QR secrets in activity state.
        backStack.addAll(savedInstanceState?.getStringArrayList("navigation") ?: emptyList())
        shell = ManagementShell(this, ::goBack) { navigate(it) }
        HostRuntime.io.execute {
            store.load()
            runOnUiThread {
                loaded = true
                // A recreated post-pairing page must not reopen its consumed App Link.
                val invitation = if (savedInstanceState == null) intent.dataString else null
                invitation?.let { showInvitation(it) } ?: render()
                resumeScanner()
                refreshSystemReadiness()
            }
        }
        render()
    }

    override fun onStart() {
        super.onStart()
        listening = true
        store.listeners.add(listener)
        LocalSettingsProtection.listeners.add(protectionListener)
        giveControl.listeners.add(giveListener)
        giveListener()
        ForegroundAccess.start(this, foregroundOwner)
        if (loaded) render()
    }

    override fun onResume() {
        super.onResume()
        if (loaded) refreshSystemReadiness()
    }

    private fun refreshSystemReadiness() {
        val allowed = WakeSupport.notificationsAllowed(this)
        if (lastNotificationsAllowed != allowed) {
            lastNotificationsAllowed = allowed
            val app = applicationContext
            HostRuntime.io.execute {
                WakeSupport.register(app)
                WakeSupport.enqueue(app, androidx.work.Data.EMPTY, registration = true)
            }
        }
        render()
        val request = ++readinessRequest
        val future = PackageManagerCompat.getUnusedAppRestrictionsStatus(applicationContext)
        future.addListener({
            val status =
                try {
                    future.get()
                } catch (_: Exception) {
                    UnusedAppRestrictionsConstants.ERROR
                }
            runOnUiThread {
                if (isDestroyed || request != readinessRequest) return@runOnUiThread
                if (unusedRestrictions != status) {
                    unusedRestrictions = status
                    if (listening) render()
                }
            }
        }, HostRuntime.io)
    }

    private fun openNotificationSettings() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    private fun sessionStatus(status: String): String =
        when (status) {
            "Connecting", "Device connected; securing session" -> "Connecting…"
            "Waiting for your device" -> "Waiting for device"
            "Encrypted session established" -> "Connected securely"
            "Encrypted connection passed" -> "Connection verified"
            "Remote control connected" -> "Viewing and control connected"
            else -> "Connection ended"
        }

    override fun onStop() {
        listening = false
        LocalSettingsProtection.set(foregroundOwner, false)
        handler.removeCallbacks(refresh)
        store.listeners.remove(listener)
        LocalSettingsProtection.listeners.remove(protectionListener)
        giveControl.listeners.remove(giveListener)
        if (!isChangingConfigurations) giveControl.cancel()
        ForegroundAccess.stop(foregroundOwner)
        super.onStop()
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.dataString?.let { showInvitation(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putStringArrayList("navigation", ArrayList(backStack))
        outState.putString("page", page)
        outState.putString("deviceId", deviceId)
        super.onSaveInstanceState(outState)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun goBack() {
        if (shell.closeDrawer()) return
        scanner.ignore()
        giveControl.cancel()
        if (backStack.isNotEmpty()) {
            page = backStack.removeAt(backStack.lastIndex)
            notice = null
            pending = null
            render()
        } else if (page != "home") {
            navigate("home")
        } else {
            finish()
        }
    }

    private fun navigate(
        value: String,
        id: String? = null,
    ) {
        if (page != value) scanner.ignore()
        if (page == "pair" && value != "pair") giveControl.cancel()
        if (value in setOf("home", "devices", "activity", "settings")) {
            backStack.clear()
        } else if (page != value) {
            backStack.add(page)
        }
        page = value
        deviceId = id
        notice = null
        if (value != "grant") pending = null
        render()
    }

    private fun render() {
        if (isDestroyed || isFinishing) return
        val sensitive = page in setOf("pair", "grant", "unlock", "saved-pin")
        val protected = sensitive && !LocalSettingsProtection.unrestricted
        val secretPage = page == "pair" && !LocalSettingsProtection.unrestricted
        if (secretPage) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        LocalSettingsProtection.set(foregroundOwner, listening && sensitive, page == "pair")
        shell.page(
            page,
            when (page) {
                "settings" -> "Settings"
                "features" -> "Set up this phone"
                "pair" -> "Give control"
                "activity" -> "Activity"
                "devices" -> "Allowed browsers"
                "device" -> deviceId?.let(store::device)?.nickname ?: "Device"
                "background" -> "Connection details"
                "appearance" -> "Appearance"
                "about" -> "About"
                "grant" -> "Allow this browser?"
                "unlock" -> "Unlocking"
                "saved-pin" -> "Saved PIN"
                else -> "This phone"
            },
        )
        val layout = shell.body
        if (!loaded) {
            text(layout, "Loading…")
            return
        }
        if (store.snapshot.settings.unrestrictedUpgradeNotice && page in setOf("home", "settings")) {
            text(
                layout,
                "This update enabled unrestricted remote control for your paired devices. " +
                    "They can change unlock settings and add controllers. You can turn this off in Settings.",
                14f,
            )
            button(layout, "Got it", R.id.dismiss_unrestricted_notice) { change { it.dismissUnrestrictedUpgradeNotice() } }
        }
        if (protected) {
            if (!secretPage) text(layout, getString(R.string.local_settings_explanation), 14f).id = R.id.local_settings_notice
            // An already dispatched swipe or held-contact release must finish before
            // sensitive controls exist; its final UP must not activate a new control.
            if (ScreenAccessService.current?.inputInFlight == true) {
                handler.removeCallbacks(refresh)
                handler.postDelayed(refresh, 50)
                return
            }
        }
        notice?.let { text(layout, it, 16f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE } }
        when (page) {
            "settings" -> settings(layout)
            "features" -> features(layout)
            "pair" -> pairing(layout)
            "activity" -> activity(layout)
            "devices" -> devices(layout)
            "device" -> device(layout)
            "background" -> backgroundSettings(layout)
            "appearance" -> appearance(layout)
            "about" -> about(layout)
            "grant" -> invitation(layout)
            "unlock" -> unlockSettings(layout)
            "saved-pin" -> savedPinSettings(layout)
            else -> home(layout)
        }
    }

    private fun home(layout: LinearLayout) {
        val state = store.snapshot
        val live = HostSessions.current.get()
        val devices = state.devices.filter { !it.revoked }
        val status =
            when {
                !state.settings.armed -> "Remote access is off"
                devices.isEmpty() -> "Allow a browser to view and control this phone"
                live != null -> "${store.device(live.deviceId)?.nickname ?: "Device"} · ${sessionStatus(live.status)}"
                devices.none { it.enabled } -> "Access is paused for all paired devices"
                !state.settings.automatic -> "Available while this app is open"
                com.google.firebase.FirebaseApp
                    .getApps(this)
                    .isEmpty() -> "Background connections need attention"
                !WakeSupport.notificationsAllowed(this) -> "Background connections need notifications"
                devices.any { it.enabled && (!it.synced || !it.wakeReady) } -> "Updating connection setup…"
                else -> "Ready for connection requests"
            }
        val access = section(layout)
        toggle(access, "Allow remote access", state.settings.armed, R.id.access_toggle) { enabled ->
            change { it.settings(armed = enabled) }
        }
        text(access, status).apply {
            id = R.id.host_status
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        if (live != null) {
            button(access, "Stop connection", R.id.disconnect_device) { HostRuntime.disconnect(this, live.deviceId) }
        }
        if (state.settings.armed && devices.any { it.enabled }) {
            if (ScreenAccessService.current == null) {
                row(layout, "Screen access is off", "Review to enable viewing and control", R.id.review_settings) { navigate("settings") }
            }
            if (state.settings.automatic &&
                (
                    !WakeSupport.notificationsAllowed(this) ||
                        devices.any { it.enabled && (!it.synced || !it.wakeReady) }
                )
            ) {
                row(layout, "Background connections", "Review connection setup", R.id.background_settings) { navigate("background") }
            }
        }
        if (state.settings.armed && devices.isNotEmpty() && devices.none { it.enabled }) {
            row(layout, "Allowed browsers", "Choose who can control this phone", R.id.manage_access) { navigate("devices") }
        }
        if (devices.isEmpty()) {
            button(layout, "Give control", R.id.pair_device) { navigate("pair") }
        } else {
            button(layout, "Give control", R.id.pair_device) { navigate("pair") }
            text(layout, "Allowed browsers", 14f).setPadding(dp(4), dp(8), 0, dp(4))
            devices.take(3).forEach { device -> row(layout, device.nickname, deviceSummary(device)) { navigate("device", device.id) } }
            button(layout, "All browsers", R.id.all_devices) { navigate("devices") }
        }
    }

    private fun pairing(layout: LinearLayout) {
        val state = giveControl.state
        when (state.phase) {
            GiveControl.Phase.IDLE, GiveControl.Phase.FAILED, GiveControl.Phase.COMPLETED -> {
                if (state.phase == GiveControl.Phase.FAILED) text(layout, "Code expired or unavailable.")
                button(layout, "Show code", R.id.give_control) { giveControl.begin(this) }.minimumHeight = dp(64)
                text(layout, "The first browser to scan gets access.", 14f)
                if (scanner.pending != null) {
                    scanTile(layout)
                } else {
                    button(layout, "Scan browser’s code", R.id.scan_pairing_code) { scanPairingCode() }
                }
            }
            GiveControl.Phase.CREATING, GiveControl.Phase.CONNECTING -> {
                text(layout, if (state.phase == GiveControl.Phase.CREATING) "Creating code…" else "Adding browser…")
                layout.addView(ProgressBar(this))
                button(layout, "Cancel", R.id.cancel_give_control) { giveControl.cancel() }
            }
            GiveControl.Phase.WAITING -> {
                text(layout, "Scan to control this phone.").id = R.id.give_control_status
                val matrix = QRCodeWriter().encode(requireNotNull(state.link), BarcodeFormat.QR_CODE, 720, 720)
                val pixels = IntArray(720 * 720) { at -> if (matrix[at % 720, at / 720]) Color.BLACK else Color.WHITE }
                layout.addView(
                    ImageView(this).apply {
                        id = R.id.give_control_qr
                        contentDescription = "Scan to control this phone"
                        setBackgroundColor(Color.WHITE)
                        setImageBitmap(Bitmap.createBitmap(pixels, 720, 720, Bitmap.Config.ARGB_8888))
                        keepScreenOn = true
                    },
                    LinearLayout.LayoutParams(-1, dp(320)),
                )
                button(layout, "Cancel", R.id.cancel_give_control) { giveControl.cancel() }
            }
        }
    }

    /** Resume an existing browser-code scan. */
    private fun scanTile(layout: LinearLayout) {
        val tile =
            LinearLayout(this).apply {
                id = R.id.scan_pairing_code
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(dp(16), dp(24), dp(16), dp(20))
                background =
                    RippleDrawable(
                        ColorStateList.valueOf(color(android.R.attr.colorControlHighlight)),
                        GradientDrawable().apply {
                            cornerRadius = dp(16).toFloat()
                            setColor(color(R.attr.accentSurfaceColor))
                        },
                        null,
                    )
                isClickable = true
                isFocusable = true
                isEnabled = !busy && scanner.pending == null
                contentDescription = if (scanner.pending != null) "Opening scanner" else "Scan browser’s code"
                setOnClickListener { scanPairingCode() }
            }
        tile.addView(
            ImageView(this).apply {
                setImageResource(R.drawable.ic_qr_scan)
                imageTintList = ColorStateList.valueOf(color(android.R.attr.textColorPrimary))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            },
            LinearLayout.LayoutParams(dp(72), dp(72)),
        )
        text(tile, if (scanner.pending != null) "Opening scanner…" else "Scan browser’s code", 20f).apply {
            gravity = Gravity.CENTER
            isAccessibilityHeading = false
        }
        val host = Website.current(this).removePrefix("https://")
        text(tile, "On the other device, open $host/pair. Use this phone to scan the code shown there, then tap Allow.", 14f).gravity =
            Gravity.CENTER
        scanner.pending?.takeUnless { it.ignored }?.let { request ->
            val progress =
                LinearLayout(this).apply {
                    id = R.id.scanner_progress
                    gravity = Gravity.CENTER_VERTICAL
                    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
                }
            progress.addView(
                ProgressBar(this, null, android.R.attr.progressBarStyleSmall),
                LinearLayout.LayoutParams(dp(24), dp(24)).apply {
                    marginEnd =
                        dp(12)
                },
            )
            text(
                progress,
                if (android.os.SystemClock.elapsedRealtime() - request.started >
                    2000
                ) {
                    "Android may be downloading the scanner for first use. Keep this phone online."
                } else {
                    "Opening the scanner on this phone…"
                },
                14f,
            )
            tile.addView(progress, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        }
        layout.addView(tile, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
    }

    private fun deviceSummary(device: Device) =
        when {
            !device.originAllowed -> "Access unavailable"
            !device.enabled -> "Access paused"
            !store.snapshot.settings.armed -> "Allowed · Remote access is off"
            HostSessions.current.get()?.deviceId == device.id -> "Connected"
            else -> lastConnected(device)
        }

    private fun devices(layout: LinearLayout) {
        // A removed device is refused locally at once; telling the relay finishes in the background.
        val devices = store.snapshot.devices.filter { !it.revoked }
        if (devices.isEmpty()) {
            text(layout, "No paired devices yet.")
        } else {
            text(layout, "Each pairing has its own access. Remove old entries you no longer use.", 14f)
        }
        devices.forEach { device ->
            row(layout, device.nickname, deviceSummary(device)) { navigate("device", device.id) }
        }
        val pendingRemovals = store.snapshot.devices.count { it.revoked }
        if (pendingRemovals > 0) {
            val label =
                when (pendingRemovals) {
                    1 -> "1 removed device is waiting for cleanup."
                    else -> "$pendingRemovals removed devices are waiting for cleanup."
                }
            text(layout, "$label Access is already blocked on this phone.", 14f).id = R.id.cleanup_status
            button(layout, "Retry cleanup", R.id.retry_cleanup) {
                WakeSupport.enqueue(this, androidx.work.Data.EMPTY, registration = true)
                notice = "Retrying cleanup. Access remains blocked on this phone."
                render()
            }
        }
        button(layout, "Allow another browser", R.id.pair_device) { navigate("pair") }
    }

    private fun scanPairingCode() {
        if (busy || scanner.pending != null) return
        if (page != "pair") navigate("pair")
        scanner.begin(page) ?: return
        notice = null
        render()
        handler.post { if (!isDestroyed && !isFinishing) resumeScanner() }
        handler.postDelayed({ if (!isDestroyed && listening && scanner.pending != null) render() }, 2100)
    }

    private fun resumeScanner() {
        val request = scanner.pending ?: return
        if (request.ignored && request.task == null) {
            scanner.take(request)
            render()
            return
        }
        if (observedScan === request) return
        observedScan = request
        val task =
            request.task ?: try {
                scanner.open(this)
            } catch (error: Exception) {
                Tasks.forException<String>(error)
            }.also { request.task = it }
        val owner = WeakReference(this)
        task.addOnCompleteListener { completed -> owner.get()?.finishScanner(request, completed) }
    }

    private fun finishScanner(
        request: PairingScanner.Request,
        task: Task<String>,
    ) {
        if (isDestroyed || isFinishing || !loaded || !scanner.take(request)) return
        observedScan = null
        request.task = null
        val cancelled = task.isCanceled || (task.exception as? MlKitException)?.errorCode == MlKitException.CODE_SCANNER_CANCELLED
        if (request.ignored || page != request.page || cancelled) {
            render()
        } else if (task.isSuccessful) {
            showInvitation(task.result)
        } else {
            notice =
                if ((task.exception as? MlKitException)?.errorCode == MlKitException.INTERNAL) {
                    // Scanner 16.1.0 maps a delegate result without data (including
                    // Android Back) to INTERNAL. Do not diagnose it as a failed
                    // launch or infer that a code was scanned or access approved.
                    "Scan ended without a code. Try again or open a pairing link from the other browser."
                } else {
                    "Couldn’t open the scanner. Keep this phone online, check Google Play services and try again. You can also open a pairing link from the other browser."
                }
            render()
        }
    }

    private fun features(layout: LinearLayout) {
        val device = deviceId?.let(store::device)
        text(layout, "${device?.nickname ?: "The device"} is paired.", 20f)
        text(layout, "Choose how you want to use this phone. You can change these later in Settings.")
        setupChecklist(layout, device)
        shell.actions.visibility = View.VISIBLE
        button(shell.actions, "Continue", R.id.skip_features) {
            // Setup is complete by choice; Back from the result must not reopen onboarding.
            backStack.clear()
            backStack.add("home")
            page = "device"
            notice = null
            render()
        }
    }

    /** What remote access needs, as switches showing Android's actual state; a tap starts the change. */
    private fun setupChecklist(
        layout: LinearLayout,
        device: Device?,
    ) {
        val screen = ScreenAccessService.current != null
        val automatic = store.snapshot.settings.automatic
        val notifications = WakeSupport.notificationsAllowed(this)
        val restore = RestartRecovery.enabled(this)
        val list = section(layout)
        text(list, "Phone access", 20f)
        check(
            list,
            "Screen and control",
            if (screen) "Paired devices can view and control" else "Needed to see and control the screen",
            screen,
            R.id.screen_access,
        ) { screenAccess(screen) }
        check(
            list,
            "Connect while the app is closed",
            when {
                automatic && notifications -> "Allows background connection requests"
                automatic -> "Needs notifications to work"
                else -> "Only while this app is open"
            },
            automatic,
            R.id.enable_wake,
        ) {
            if (!automatic && !notifications) allowNotifications(prompt = true)
            change { it.settings(automatic = !automatic) }
        }
        if (automatic && !notifications) {
            button(
                list,
                "Allow notifications",
                R.id.allow_notifications,
            ) { allowNotifications(prompt = false) }
        }
        check(list, "Reconnect after restart", "After you unlock the phone once", restore, R.id.restore_setup) {
            perform { RestartRecovery.setEnabled(this, !restore) }
        }
        val optional = section(layout)
        text(optional, "Optional · Unlocking", 14f)
        if (device != null) {
            row(
                optional,
                "Unlock from ${device.nickname}",
                if (device.unlockAllowed) "Allowed · Change on this phone" else "Not allowed · Change on this phone",
                R.id.unlock_settings,
            ) { navigate("unlock", device.id) }
        }
        val saved = PinVault(this).saved()
        row(
            optional,
            "Save PIN on this phone",
            if (saved) "Unlock without typing the PIN" else "Otherwise type the PIN to unlock",
            R.id.saved_pin_settings,
        ) { navigate("saved-pin") }
    }

    private fun screenAccess(enabled: Boolean) {
        if (enabled) {
            AlertDialog
                .Builder(this)
                .setTitle("Turn off screen access?")
                .setMessage(
                    "Paired devices will no longer see or control the screen. Turning it back on takes a few steps in Android settings.",
                ).setNegativeButton("Cancel", null)
                .setPositiveButton("Turn off") { _, _ ->
                    ScreenAccessService.current?.disableSelf()
                    handler.postDelayed({ render() }, 500)
                }.show()
            return
        }
        AlertDialog
            .Builder(this)
            .setTitle("Allow remote screen access?")
            .setMessage(
                "YepControl uses Android accessibility to let browsers you approve view this phone’s screen " +
                    "and perform taps, swipes and typing you request. Screen content may include private information from other apps.\n\n" +
                    "Screen content and controls are encrypted between your devices. " +
                    "You can stop remote access in YepControl or Android settings.",
            ).setNegativeButton("Cancel", null)
            .setPositiveButton("Agree and continue") { _, _ -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            .show()
    }

    /** Android stops showing the prompt after repeated refusals; then only its settings page can allow notifications. */
    private fun allowNotifications(prompt: Boolean) {
        if (Build.VERSION.SDK_INT >= 33 && (prompt || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            openNotificationSettings()
        }
    }

    private fun connectionRequests(layout: LinearLayout) {
        text(
            layout,
            "Paired devices can contact this phone while the app is closed when that is on in Settings. " +
                "Delivery depends on Android and network availability.",
            14f,
        )
        text(
            layout,
            if (WakeSupport.notificationsAllowed(
                    this,
                )
            ) {
                "Notifications are on"
            } else {
                "Notifications are off. Turn them on to receive connection requests."
            },
        )
        button(layout, "Notification settings", R.id.notification_settings) {
            openNotificationSettings()
        }
    }

    private fun settings(layout: LinearLayout) {
        setupChecklist(layout, null)
        row(layout, "Connection details", "Notifications and connection setup", R.id.background_settings) { navigate("background") }
        row(
            layout,
            "Appearance",
            when (Appearance.choice(this)) {
                "light" -> "Light"
                "dark" -> "Dark"
                else -> "System"
            },
            R.id.appearance_settings,
        ) {
            navigate("appearance")
        }
        row(layout, "About", "App version and information", R.id.about_settings) { navigate("about") }
        if (Website.developmentAvailable) {
            toggle(layout, "Use development website", Website.development(this), R.id.development_website) { enabled ->
                perform { Website.setDevelopment(this, enabled) }
            }
            text(layout, "Debug build. New pairing codes must come from ${Website.current(this).removePrefix("https://")}.", 14f)
        }
        unrestrictedSettings(layout)
    }

    private fun unrestrictedSettings(layout: LinearLayout) {
        toggle(
            layout,
            "Allow unrestricted remote control",
            store.snapshot.settings.unrestrictedRemoteControl,
            R.id.unrestricted_remote_control,
        ) { enabled ->
            if (enabled) {
                AlertDialog
                    .Builder(this)
                    .setTitle("Allow unrestricted remote control?")
                    .setMessage(
                        "Paired controllers can change unlock settings and add other controllers. " +
                            "Their access lasts until you remove them. Android permissions and each device’s unlock access still apply.",
                    ).setNegativeButton("Cancel") { _, _ -> render() }
                    .setOnCancelListener { render() }
                    .setPositiveButton("Allow") { _, _ -> change { it.unrestrictedRemoteControl(true) } }
                    .show()
            } else {
                change { it.unrestrictedRemoteControl(false) }
            }
        }
        text(
            layout,
            if (store.snapshot.settings.unrestrictedRemoteControl) {
                "On. Paired controllers can configure this app and add controllers."
            } else {
                "Off. Pairing and unlock configuration are protected. A trusted controller can turn this on here."
            },
            14f,
        )
    }

    private fun appearance(layout: LinearLayout) {
        text(layout, "Choose how this app looks. System follows your phone’s appearance setting.", 14f)
        val selected = Appearance.choice(this)
        val choices = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
        for ((mode, resource) in listOf(
            "system" to R.id.appearance_system,
            "light" to R.id.appearance_light,
            "dark" to R.id.appearance_dark,
        )) {
            choices.addView(
                RadioButton(this).apply {
                    id = resource
                    text = mode.replaceFirstChar { it.uppercase() }
                    textSize = 18f
                    minHeight = dp(56)
                    isChecked = mode == selected
                    isEnabled = !busy
                },
                LinearLayout.LayoutParams(-1, -2),
            )
        }
        choices.setOnCheckedChangeListener { _, checked ->
            val mode =
                when (checked) {
                    R.id.appearance_light -> "light"
                    R.id.appearance_dark -> "dark"
                    else -> "system"
                }
            if (mode != selected) {
                perform {
                    Appearance.save(this, mode)
                    runOnUiThread { recreate() }
                }
            }
        }
        layout.addView(choices)
    }

    private fun backgroundSettings(layout: LinearLayout) {
        connectionRequests(layout)
        text(layout, "When this app is unused", 20f)
        // Android exempts apps with an enabled accessibility service; its own status check does not say so.
        val exempt =
            Settings.Secure
                .getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                ?.split(':')
                ?.any { it.startsWith("$packageName/") } == true
        val restricted =
            unusedRestrictions in
                setOf(
                    UnusedAppRestrictionsConstants.API_30_BACKPORT,
                    UnusedAppRestrictionsConstants.API_30,
                    UnusedAppRestrictionsConstants.API_31,
                )
        text(
            layout,
            when {
                exempt -> "Android doesn’t pause this app while screen access is on."
                unusedRestrictions == null -> "Checking Android settings…"
                unusedRestrictions == UnusedAppRestrictionsConstants.DISABLED -> "Android won’t pause this app when it’s unused."
                unusedRestrictions == UnusedAppRestrictionsConstants.FEATURE_NOT_AVAILABLE ->
                    "Android does not pause unused apps on this phone."
                restricted ->
                    "Android may remove permissions and archive this app after months unused. " +
                        "To prevent that, turn off “Manage app if unused” at the bottom of App info."
                else -> "Couldn’t check whether Android pauses this app. Review its app settings."
            },
            14f,
        ).id = R.id.unused_app_status
        if (!exempt && (restricted || unusedRestrictions == UnusedAppRestrictionsConstants.ERROR)) {
            button(layout, "Open App info", R.id.unused_app_settings) {
                unusedAppSettings.launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri()))
            }
        }
        text(layout, "Connection setup", 20f)
        button(layout, "Retry setup", R.id.retry_setup) {
            HostRuntime.io.execute {
                WakeSupport.register(this)
                WakeSupport.enqueue(this, androidx.work.Data.EMPTY, registration = true)
            }
            notice = "Updating connection settings…"
            render()
        }
        if (com.google.firebase.FirebaseApp
                .getApps(this)
                .isEmpty()
        ) {
            text(layout, "Connection requests are unavailable in this installation. Install an app update to complete setup.", 14f)
        }
    }

    private fun about(layout: LinearLayout) {
        row(layout, "Privacy policy", "How YepControl handles your data", R.id.privacy_policy) {
            startActivity(Intent(Intent.ACTION_VIEW, (BuildConfig.SHARING_WEBSITE + "/privacy/").toUri()))
        }
        text(layout, "YepControl ${BuildConfig.VERSION_NAME}", 14f)
        text(layout, "Pair devices to view and control this phone securely.", 14f)
        text(
            layout,
            "After a restart, unlock the phone locally once. Activity is stored only on this phone for up to 30 days or 10,000 entries.",
            14f,
        )
    }

    private fun device(layout: LinearLayout) {
        val device =
            deviceId?.let(store::device)?.takeIf { !it.revoked } ?: run {
                handler.post { if (page == "device") goBack() }
                return
            }
        val live = HostSessions.current.get()
        val connection = section(layout)
        val status =
            when {
                !device.originAllowed -> "Access unavailable"
                live?.deviceId == device.id -> sessionStatus(live.status)
                !device.enabled -> "Access paused"
                !store.snapshot.settings.armed -> "Remote access is off"
                else -> "Not connected"
            }
        text(connection, status, 20f)
        if (!device.originAllowed) {
            val website = Website.current(this)
            text(
                connection,
                "This pairing uses a service this app no longer supports. Remove this device, then create a new code at $website.",
            )
        }
        if (live?.deviceId == device.id) {
            button(connection, "Disconnect", R.id.disconnect_device) { HostRuntime.disconnect(this, device.id) }
        }
        toggle(layout, "Allow this device", device.enabled, R.id.device_toggle) { enabled -> change { it.enable(device.id, enabled) } }
        val setupIssue =
            when {
                ScreenAccessService.current == null -> "Screen access is off. Enable it to view and control this phone."
                store.snapshot.settings.automatic && !WakeSupport.notificationsAllowed(this) -> "Background requests need notifications."
                else -> null
            }
        if (setupIssue != null) {
            row(layout, "Phone setup", setupIssue, R.id.open_features) { navigate("features", device.id) }
        }
        row(
            layout,
            "Unlocking",
            if (device.unlockAllowed) "Allowed · Change on this phone" else "Not allowed · Change on this phone",
            R.id.unlock_settings,
        ) { navigate("unlock", device.id) }
        shell.titleAction("Rename ${device.nickname}", R.drawable.ic_edit, R.id.rename_device) {
            val input =
                EditText(this).apply {
                    setText(device.nickname)
                    isSingleLine = true
                    filters = arrayOf(android.text.InputFilter.LengthFilter(60))
                    setSelectAllOnFocus(true)
                }
            val field = android.widget.FrameLayout(this).apply { setPadding(dp(24), dp(8), dp(24), 0) }
            field.addView(input)
            AlertDialog
                .Builder(this)
                .setTitle("Rename device")
                .setView(field)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save") { _, _ -> perform { store.rename(device.id, input.text.toString()) } }
                .show()
                .window
                ?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
            input.requestFocus()
        }
        text(layout, "Paired ${time(device.pairedAt)}\n${lastConnected(device)}", 14f)
        button(layout, getString(R.string.remove_device), R.id.remove_device) {
            AlertDialog
                .Builder(
                    this,
                ).setTitle("Remove ${device.nickname}?")
                .setMessage(
                    "This device will lose access to this phone immediately. An old entry may remain on your other device and can be forgotten there.",
                ).setNegativeButton("Cancel", null)
                .setPositiveButton("Remove") { _, _ ->
                    change(saved = { if (page == "device") goBack() }) { it.revoke(device.id) }
                }.show()
        }
    }

    private fun unlockSettings(layout: LinearLayout) {
        val device =
            deviceId?.let(store::device)?.takeIf { !it.revoked } ?: run {
                handler.post { if (page == "unlock") goBack() }
                return
            }
        text(layout, device.nickname, 20f)
        toggle(layout, "Allow unlocking", device.unlockAllowed, R.id.allow_unlock) { enabled ->
            change { it.allowUnlock(device.id, enabled) }
        }
        text(layout, "Lets this device submit a PIN or request the PIN saved on this phone.", 14f)
    }

    private fun savedPinSettings(layout: LinearLayout) {
        val saved = PinVault(this).saved()
        check(
            layout,
            "Save PIN on this phone",
            if (saved) "Unlock without typing the PIN" else "Otherwise type the PIN to unlock",
            saved,
            R.id.save_pin,
        ) { if (saved) UnlockSetup.forget(this) { render() } else UnlockSetup.show(this) { render() } }
    }

    private fun activity(layout: LinearLayout) {
        text(layout, "Recent activity · Stored on this phone", 14f)
        val container = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        layout.addView(container)
        HostRuntime.io.execute {
            val events = store.events(activityLimit)
            runOnUiThread {
                if (isDestroyed || page != "activity" || !container.isAttachedToWindow) return@runOnUiThread
                if (events.isEmpty()) text(container, "No activity yet.")
                events.forEach { event ->
                    val entry = section(container)
                    text(
                        entry,
                        when (event.kind) {
                            "Wake setup completed" -> "Connection settings updated"
                            "Wake setup failed" -> "Connection setup needs attention"
                            "Session blocked: phone busy" -> "Connection declined · Phone busy"
                            else -> event.kind
                        },
                        16f,
                    )
                    text(entry, "${time(event.at)}${event.deviceName?.let { " · $it" } ?: ""}", 14f)
                }
                shell.restoreScroll()
                if (events.size == activityLimit && activityLimit < 10000) {
                    button(container, "Show older activity") {
                        activityLimit = (activityLimit + 200).coerceAtMost(10000)
                        render()
                    }
                }
            }
        }
    }

    private fun showInvitation(uri: String) {
        scanner.ignore()
        giveControl.cancel()
        try {
            check(!busy)
            pending = null
            granting = null
            if (page == "grant") {
                page = "home"
                backStack.clear()
            }
            pending = Enrollment(uri, Website.current(this))
            backStack.clear()
            backStack.add("home")
            page = "grant"
            notice = null
            render()
        } catch (_: EnrollmentOriginMismatch) {
            notice = "Use a pairing code from ${Website.current(this)}."
            render()
        } catch (_: Exception) {
            notice = "Invalid or expired pairing code. Create a new code on your other device."
            render()
        }
    }

    private fun invitation(layout: LinearLayout) {
        val invitation =
            pending ?: run {
                navigate("home")
                return
            }
        val name = invitation.name
        text(layout, name, 20f)
        text(layout, invitation.origin.removePrefix("https://"), 14f)
        if (granting === invitation) {
            val progress = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
            progress.addView(
                ProgressBar(this, null, android.R.attr.progressBarStyleSmall).apply {
                    indeterminateTintList = ColorStateList.valueOf(color(android.R.attr.colorAccent))
                },
                LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginEnd = dp(12) },
            )
            text(progress, "Connecting to $name…").accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            layout.addView(progress, LinearLayout.LayoutParams(-1, dp(52)))
        } else {
            text(layout, "This name is supplied by the other device. Only allow a browser you chose to connect.", 14f)
            text(layout, "This adds access. Earlier pairings keep their access until you remove them in Allowed browsers.", 14f)
            button(layout, getString(R.string.grant_device), R.id.grant_device) { allow(invitation) }
        }
        button(layout, "Cancel", R.id.cancel_grant) {
            granting = null
            navigate("home")
        }
    }

    private fun allow(invitation: Enrollment) {
        if (granting != null) return
        val firstDevice = store.snapshot.devices.none { !it.revoked }
        granting = invitation
        render()
        HostRuntime.network.execute {
            val paired =
                try {
                    val accepted =
                        invitation.grant(KeystoreIdentity.loadOrCreate("phone-identity-v1"), DeviceInfo.report(this)) {
                            granting !== invitation
                        }
                    store.pair(accepted, invitation.name).also {
                        WakeSupport.enqueue(this, androidx.work.Data.EMPTY, registration = true)
                    }
                } catch (error: Exception) {
                    if (BuildConfig.DEBUG) android.util.Log.w("RemoteAccess", "Pairing failed: ${error.javaClass.simpleName}")
                    null
                }
            runOnUiThread {
                if (granting !== invitation) return@runOnUiThread
                granting = null
                pending = null
                backStack.clear()
                if (paired == null) {
                    page = "home" // A pairing code is single-use; the other device must create a new one.
                    notice =
                        "Pairing wasn’t confirmed. Check Allowed browsers for an added entry before trying again. Another pairing adds access."
                } else {
                    backStack.add("home")
                    page = if (firstDevice) "features" else "device"
                    deviceId = paired.id
                }
                render()
                if (paired != null) shell.message("${paired.nickname} paired")
            }
        }
    }

    private fun change(
        saved: () -> Unit = {},
        work: (HostStore) -> Unit,
    ) {
        if (changing) return
        changing = true
        notice = null
        render()
        HostRuntime.change(this, work, finished = { ok ->
            runOnUiThread {
                changing = false
                if (ok) saved() else notice = "Couldn’t save the change. Check the current access setting and try again."
                render()
            }
        })
    }

    private fun perform(
        network: Boolean = false,
        work: () -> Unit,
    ) {
        if (busy) return
        busy = true
        render()
        (if (network) HostRuntime.network else HostRuntime.io).execute {
            try {
                work()
            } catch (
                error: Exception,
            ) {
                if (BuildConfig.DEBUG) android.util.Log.w("RemoteAccess", "Action failed: ${error.javaClass.simpleName}")
                runOnUiThread { notice = "Couldn’t complete the action. Check your connection and try again." }
            } finally {
                runOnUiThread {
                    busy = false
                    render()
                }
            }
        }
    }

    private fun color(attr: Int): Int = TypedValue().also { theme.resolveAttribute(attr, it, true) }.data

    private fun section(layout: LinearLayout): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(12))
            background =
                GradientDrawable().apply {
                    cornerRadius = dp(16).toFloat()
                    setColor(color(R.attr.surfaceColor))
                    setStroke(dp(1), color(R.attr.outlineColor))
                }
            layout.addView(this, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) })
        }

    private fun row(
        layout: LinearLayout,
        label: String,
        summary: String,
        resource: Int = View.NO_ID,
        action: () -> Unit,
    ) {
        val row =
            LinearLayout(this).apply {
                id = resource
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(76)
                setPadding(dp(16), dp(8), dp(16), dp(8))
                background =
                    RippleDrawable(
                        ColorStateList.valueOf(color(android.R.attr.colorControlHighlight)),
                        GradientDrawable().apply {
                            cornerRadius = dp(12).toFloat()
                            setColor(color(R.attr.surfaceColor))
                            setStroke(dp(1), color(R.attr.outlineColor))
                        },
                        null,
                    )
                isFocusable = true
                isClickable = true
                isEnabled = !busy
                setOnClickListener { action() }
            }
        val copy =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            }
        text(copy, label, 17f).apply {
            setTypeface(null, Typeface.BOLD)
            setPadding(0, dp(2), 0, dp(2))
        }
        text(copy, summary, 14f).setPadding(0, dp(2), 0, dp(2))
        row.contentDescription = "$label. $summary"
        row.addView(copy, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(
            TextView(this).apply {
                text = if (resources.configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL) "‹" else "›"
                textSize = 26f
                setPadding(dp(12), 0, 0, 0)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            },
        )
        layout.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
    }

    private fun text(
        layout: LinearLayout,
        value: String,
        size: Float = 16f,
    ): TextView =
        TextView(this).apply {
            text = value
            textSize = size
            setTextColor(color(if (size < 16f) android.R.attr.textColorSecondary else android.R.attr.textColorPrimary))
            if (size >= 20f) {
                setTypeface(null, Typeface.BOLD)
                isAccessibilityHeading = true
            }
            setPadding(0, dp(7), 0, dp(7))
            layout.addView(this)
        }

    private fun button(
        layout: LinearLayout,
        label: String,
        resource: Int = View.NO_ID,
        action: () -> Unit,
    ): Button =
        Button(this).apply {
            id = resource
            text = label
            isAllCaps = false
            minHeight = dp(52)
            val primary = resource in setOf(R.id.pair_device, R.id.grant_device, R.id.skip_features, R.id.save_pin)
            backgroundTintList = ColorStateList.valueOf(color(if (primary) android.R.attr.colorAccent else R.attr.accentSurfaceColor))
            setTextColor(color(if (primary) R.attr.onAccentColor else android.R.attr.textColorPrimary))
            isEnabled = !busy || resource == R.id.navigate_back
            setOnClickListener { action() }
            layout.addView(this, LinearLayout.LayoutParams(if (layout.orientation == LinearLayout.VERTICAL) -1 else -2, -2))
        }

    private fun toggle(
        layout: LinearLayout,
        label: String,
        checked: Boolean,
        resource: Int,
        action: (Boolean) -> Unit,
    ) {
        layout.addView(
            Switch(this).apply {
                id = resource
                text = label
                textSize = 18f
                minHeight = dp(56)
                isChecked = checked
                isEnabled = loaded && !changing && (!busy || resource == R.id.access_toggle)
                setOnCheckedChangeListener { _, enabled -> action(enabled) }
            },
            LinearLayout.LayoutParams(-1, -2),
        )
    }

    private fun check(
        layout: LinearLayout,
        label: String,
        summary: String,
        checked: Boolean,
        resource: Int,
        action: () -> Unit,
    ) {
        layout.addView(
            Switch(this).apply {
                id = resource
                val detail =
                    SpannableString(summary).apply {
                        setSpan(RelativeSizeSpan(0.82f), 0, length, 0)
                        setSpan(ForegroundColorSpan(color(android.R.attr.textColorSecondary)), 0, length, 0)
                    }
                text = SpannableStringBuilder().append(label, StyleSpan(Typeface.BOLD), 0).append("\n").append(detail)
                textSize = 17f
                minHeight = dp(64)
                setPadding(0, dp(6), 0, dp(6))
                isChecked = checked
                isEnabled = loaded && !changing && !busy
                setOnClickListener {
                    isChecked = checked // Shows Android's state until the change is confirmed.
                    action()
                }
            },
            LinearLayout.LayoutParams(-1, -2),
        )
    }

    private fun time(value: Long) = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(value))

    private fun lastConnected(device: Device) =
        if (device.lastConnected == 0L) {
            "Never connected"
        } else {
            "Last connected ${time(
                device.lastConnected,
            )}"
        }
}

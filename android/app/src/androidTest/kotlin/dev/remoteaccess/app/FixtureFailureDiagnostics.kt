package dev.remoteaccess.app

import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import java.io.File
import java.util.concurrent.TimeUnit

/** Only booleans, counts and fixed enums leave an owned fixture after failure. */
class FixtureFailureDiagnostics : TestWatcher() {
    override fun failed(
        e: Throwable,
        description: Description,
    ) {
        runCatching {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val device = UiDevice.getInstance(instrumentation)
            if (device.executeShellCommand("getprop ro.kernel.qemu").trim() != "1") return
            val context = instrumentation.targetContext
            val snapshot = HostStore.get(context).load().snapshot
            val preferences = WakeSupport.preferences(context)
            val failureClass =
                Regex("Pairing failed: ([A-Za-z]+)")
                    .findAll(device.executeShellCommand("logcat -d -t 200 -s RemoteAccess:W"))
                    .lastOrNull()
                    ?.groupValues
                    ?.get(1)
            val pairingFailureKind =
                when (failureClass) {
                    null -> "none"
                    "SocketTimeoutException",
                    "SSLHandshakeException",
                    "UnknownHostException",
                    "ConnectException",
                    "IOException",
                    -> "network"
                    "IllegalStateException", "IllegalArgumentException", "SignatureException", "JSONException" -> "protocol"
                    else -> "other"
                }
            val wakeState =
                when (preferences.getString("wakeState", null)) {
                    null -> "unset"
                    "Device settings synchronized" -> "synchronized"
                    "Wake registration unavailable. Retry in Settings." -> "registration-unavailable"
                    "Some device settings could not be synchronized. Retry in Settings." -> "sync-incomplete"
                    else -> "other"
                }
            val jobs =
                WorkManager
                    .getInstance(context)
                    .getWorkInfosForUniqueWork("register-push")
                    .get(3, TimeUnit.SECONDS)
            var phoneCodePhase = "unavailable"
            var inputInFlight = false
            instrumentation.runOnMainSync {
                val activity =
                    ActivityLifecycleMonitorRegistry
                        .getInstance()
                        .getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<MainActivity>()
                        .singleOrNull()
                if (activity != null) {
                    phoneCodePhase =
                        ViewModelProvider(activity)[GiveControl::class.java]
                            .state.phase.name
                            .lowercase()
                }
                inputInFlight = dev.remoteaccess.app.control.ScreenAccessService.current
                    ?.inputInFlight == true
            }
            val result =
                JSONObject()
                    .put("phoneCodePhase", phoneCodePhase)
                    .put("inputInFlight", inputInFlight)
                    .put("armed", snapshot.settings.armed)
                    .put("automatic", snapshot.settings.automatic)
                    .put("notificationsAllowed", WakeSupport.notificationsAllowed(context))
                    .put("fidPresent", preferences.contains("fid"))
                    .put("approvalVisible", device.hasObject(By.res("${context.packageName}:id/grant_device")))
                    .put("pairingFailureVisible", device.hasObject(By.textStartsWith("Pairing wasn’t confirmed.")))
                    .put("cameraAllowed", snapshot.settings.cameraAllowed)
                    .put("microphoneAllowed", snapshot.settings.microphoneAllowed)
                    .put(
                        "cameraPermission",
                        dev.remoteaccess.app.media.MediaController
                            .permission(context, true),
                    ).put(
                        "microphonePermission",
                        dev.remoteaccess.app.media.MediaController
                            .permission(context, false),
                    ).put(
                        "sensorPermissionButtonVisible",
                        device.hasObject(By.res("com.android.permissioncontroller:id/permission_allow_foreground_only_button")),
                    ).put("pairingFailureKind", pairingFailureKind)
                    .put("devices", snapshot.devices.size)
                    .put("synced", snapshot.devices.count { it.synced })
                    .put("wakeReady", snapshot.devices.count { it.wakeReady })
                    .put("registrationRunning", jobs.count { it.state == WorkInfo.State.RUNNING })
                    .put("registrationQueued", jobs.count { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED })
                    .put("wakeState", wakeState)
            File(context.filesDir, "hosted-failure-state.json").writeText(result.toString())
        }
    }
}

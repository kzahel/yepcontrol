package dev.remoteaccess.app.control

import android.app.KeyguardManager
import android.content.Context
import dev.remoteaccess.app.HostRuntime
import dev.remoteaccess.app.HostStore
import dev.remoteaccess.app.unlock.PinVault
import dev.remoteaccess.protocol.ControlCommand
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** One authenticated session owns one ordered command stream. Never retry input. */
internal class ControlSession(
    private val context: Context,
    private val deviceId: String,
    private val current: () -> Boolean,
    private val send: (ByteArray) -> Unit,
    private val offerDirect: ((String, (String?) -> Unit) -> Unit)? = null,
) {
    private val active = AtomicBoolean(true)
    private val busy = AtomicBoolean(false)
    private var lastId = 0L

    fun receive(bytes: ByteArray) {
        check(active.get() && current())
        val command = ControlCommand.decode(bytes)
        check(command.id > lastId) // Record replay checks do not replace command ordering.
        lastId = command.id
        check(busy.compareAndSet(false, true))
        val commandId = command.id
        val replied = AtomicBoolean(false)
        val reply = { kind: Int, payload: ByteArray ->
            if (replied.compareAndSet(false, true)) {
                busy.set(false)
                if (active.get() && current()) send(ControlCommand.reply(commandId, kind, payload))
            }
        }
        if (command.op == 19) {
            val negotiate = offerDirect
            if (negotiate == null) {
                reply(2, byteArrayOf(4))
            } else {
                negotiate(command.text) { sdp ->
                    if (sdp == null) reply(2, byteArrayOf(4)) else reply(6, sdp.toByteArray())
                }
            }
        } else if (command.op == 10) {
            val intent =
                android.content
                    .Intent(android.content.Intent.ACTION_MAIN)
                    .addCategory(android.content.Intent.CATEGORY_LAUNCHER)
            val apps =
                context.packageManager
                    .queryIntentActivities(intent, 0)
                    .distinctBy { it.activityInfo.packageName }
                    .map {
                        it.loadLabel(context.packageManager).toString().take(100) to it.activityInfo.packageName
                    }.sortedBy { it.first }
                    .take(200)
            reply(
                4,
                org.json
                    .JSONArray()
                    .apply {
                        apps.forEach { (name, pkg) -> put(JSONObject().put("name", name).put("packageName", pkg)) }
                    }.toString()
                    .toByteArray(),
            )
        } else if (command.op == 1 || command.op == 2) {
            val state =
                ScreenAccessService.current?.state() ?: JSONObject()
                    .put("type", "state")
                    .put("v", 1)
                    .put("accessibility", false)
                    .put("locked", context.getSystemService(KeyguardManager::class.java).isKeyguardLocked)
                    .put("width", 0)
                    .put("height", 0)
                    .put("scene", 0)
            val vault = PinVault(context)
            state.put("a11y", 1)
            state.put("localSettings", LocalSettingsProtection.blocked)
            state.put("video", VideoStream.state(this)).put("videoActive", VideoStream.available(context, this))
            state
                .put(
                    "device",
                    dev.remoteaccess.app.DeviceInfo
                        .report(context),
                ).put(
                    "unlockSupported",
                    true,
                ).put("unlockAllowed", HostStore.get(context).device(deviceId)?.unlockAllowed == true)
                .put("savedPin", vault.saved())
                .put("unlockBlocked", vault.guard.blocked())
            reply(1, state.toString().toByteArray())
        } else if (command.op == 16 && command.values[0] == 0) {
            // Stopping needs neither an unlocked display nor the accessibility service.
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                VideoStream.close(context, this)
                reply(2, byteArrayOf(0))
            }
        } else {
            val service = ScreenAccessService.current
            if (service == null) {
                reply(2, byteArrayOf(1))
            } else {
                val permitted = {
                    active.get() &&
                        current() &&
                        (
                            command.op !in listOf(13, 14) ||
                                HostStore.get(context).device(deviceId)?.unlockAllowed == true
                        )
                }
                if (command.op in listOf(13, 14) && permitted()) {
                    HostRuntime.io.execute { HostStore.get(context).record("Unlock requested", deviceId) }
                }
                service.execute(command, this, permitted) { kind, payload ->
                    if (command.op in listOf(13, 14) && kind == 2 && payload.size == 1) {
                        val event =
                            when (payload[0].toInt()) {
                                0 -> "Phone unlocked"
                                9 -> "Unlock needs local recovery"
                                else -> null
                            }
                        if (event != null) HostRuntime.io.execute { HostStore.get(context).record(event, deviceId) }
                    }
                    reply(kind, payload)
                }
            }
        }
    }

    fun close() {
        active.set(false)
        VideoStream.close(context, this, dev.remoteaccess.protocol.CaptureLifecycle.Reason.DISCONNECTED)
        ScreenAccessService.current?.release(this)
    }
}

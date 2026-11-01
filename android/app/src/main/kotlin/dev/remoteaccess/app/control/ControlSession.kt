package dev.remoteaccess.app.control

import android.app.KeyguardManager
import android.content.Context
import dev.remoteaccess.app.HostRuntime
import dev.remoteaccess.app.HostStore
import dev.remoteaccess.app.advanced.AdvancedControl
import dev.remoteaccess.app.media.MediaController
import dev.remoteaccess.app.unlock.PinVault
import dev.remoteaccess.protocol.ControlCommand
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** One authenticated session owns one ordered command stream. Never retry input. */
internal class ControlSession(
    private val context: Context,
    private val deviceId: String,
    private val current: () -> Boolean,
    send: (ByteArray) -> Unit,
    private val offerDirect: ((String, (String?) -> Unit) -> Unit)? = null,
    scheduler: ((() -> Unit) -> Boolean)? = null,
    onOutputFailure: () -> Unit = {},
) {
    private val active = AtomicBoolean(true)
    private val busy = AtomicBoolean(false)
    private var lastId = 0L
    private val usedMediaIds = mutableSetOf<Int>()
    private val output =
        ControlOutput({ active.get() && current() }, send, {
            close()
            onOutputFailure()
        }, scheduler)

    fun receive(bytes: ByteArray) {
        check(active.get() && current())
        val command = ControlCommand.decode(bytes)
        check(command.id > lastId) // Record replay checks do not replace command ordering.
        lastId = command.id
        val ownsBusy = command.op !in listOf(26, 27)
        if (ownsBusy) check(busy.compareAndSet(false, true))
        val commandId = command.id
        val replied = AtomicBoolean(false)
        val reply = { kind: Int, payload: ByteArray ->
            if (replied.compareAndSet(false, true)) {
                if (ownsBusy) busy.set(false)
                if (active.get() && current()) output.control(ControlCommand.reply(commandId, kind, payload))
            }
        }
        if (command.op in 24..27) {
            val stream = command.values[0]
            if (command.op in 24..25 && (usedMediaIds.size >= 1024 || !usedMediaIds.add(stream))) {
                reply(2, byteArrayOf(4))
                return
            }
            MediaController.main.post {
                if (!active.get() || !current()) {
                    reply(2, byteArrayOf(8))
                    return@post
                }
                when (command.op) {
                    26 -> {
                        MediaController.close(this, stream)
                        reply(2, byteArrayOf(0))
                    }
                    27 -> reply(2, byteArrayOf(if (MediaController.renew(this, stream)) 0 else 4))
                    else -> {
                        val camera = command.op == 24
                        val (code, request) =
                            MediaController.prepare(
                                context,
                                this,
                                HostStore.get(context).device(deviceId)?.nickname ?: "Paired controller",
                                stream,
                                camera,
                                if (camera) command.values[1] else 1,
                                if (camera) command.values[2] else 1,
                                if (camera) command.values[3] else 1,
                                { active.get() && current() },
                                output::media,
                            )
                        reply(2, byteArrayOf(code.toByte()))
                        request?.activate()
                    }
                }
            }
        } else if (command.op == 19) {
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
            MediaController.main.post {
                if (!active.get() || !current()) return@post
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
                state.put(
                    "advancedControl",
                    dev.remoteaccess.app.advanced.AdvancedControl
                        .report(context),
                )
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
                state.put("media", MediaController.state(context, this))
                reply(1, state.toString().toByteArray())
            }
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
        if (!active.compareAndSet(true, false)) return
        AdvancedControl.stop(context)
        output.close()
        MediaController.close(this, reason = 5)
        VideoStream.close(context, this, dev.remoteaccess.protocol.CaptureLifecycle.Reason.DISCONNECTED)
        ScreenAccessService.current?.release(this)
    }
}

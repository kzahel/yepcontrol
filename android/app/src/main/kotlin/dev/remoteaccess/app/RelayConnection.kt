package dev.remoteaccess.app

import dev.remoteaccess.app.control.ControlSession
import dev.remoteaccess.app.control.SessionService
import dev.remoteaccess.protocol.Authority
import dev.remoteaccess.protocol.Channel
import dev.remoteaccess.protocol.ControlCommand
import dev.remoteaccess.protocol.Identity
import dev.remoteaccess.protocol.PhoneHandshake
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

internal class RelayConnection(
    private val identity: Identity,
    private val grant: JSONObject,
    private val report: (String) -> Unit,
    private val fid: String? = null,
    private val requestId: String? = null,
    private val registrationOnly: Boolean = false,
    private val removePush: Boolean = false,
    private val accessGeneration: String? = null,
    private val accessEnabled: Boolean = true,
    private val current: () -> Boolean = { true },
    private val admit: () -> Boolean = { true },
    private val features: (() -> JSONObject)? = null,
    private val context: android.content.Context? = null,
    private val onControl: () -> Unit = {},
    private val startSession: (() -> Unit)? = null,
) : WebSocketListener() {
    private val active = AtomicBoolean(true)
    private var handshake: PhoneHandshake? = null
    private var channel: Channel? = null
    private var socket: WebSocket? = null
    private var ready = false
    private var control: ControlSession? = null
    private var relayFlow = false
    private var checked = false

    @Volatile private var direct: dev.remoteaccess.app.transport.DirectLink? = null

    fun connect() {
        Website.requireConfigured(grant.getString("origin"))
        val id = grant.getString("id")
        unhex(id, 16)
        val url = grant.getString("origin").replaceFirst("https:", "wss:") + "/api/socket?id=$id"
        socket = http.newWebSocket(Request.Builder().url(url).build(), this)
    }

    @Synchronized
    fun close(graceful: Boolean = false) {
        if (!active.compareAndSet(true, false)) return
        control?.close()
        direct?.close()
        if ((control != null || direct != null) && context != null) SessionService.stop(context)
        handshake?.close()
        channel?.close()
        if (graceful) socket?.close(1000, null) else socket?.cancel()
        report("Connection closed. Reconnect to continue.")
    }

    @Synchronized
    override fun onMessage(
        webSocket: WebSocket,
        text: String,
    ) {
        try {
            check(active.get() && current())
            val message = JSONObject(text)
            when (message.getString("type")) {
                "relayReceipt" -> {
                    check(relayFlow)
                    val nonce = message.getString("nonce")
                    unhex(nonce, 16)
                    check(webSocket.send(JSONObject().put("type", "relayAck").put("nonce", nonce).toString()))
                }
                "challenge" -> {
                    relayFlow = message.optInt("relayFlow") == 1
                    val nonce = message.getString("nonce")
                    unhex(nonce, 32)
                    val data = fields("ara/relay/auth/v1", grant.getString("origin"), grant.getString("id"), "phone", nonce)
                    webSocket.send(
                        JSONObject()
                            .put(
                                "id",
                                grant.getString("id"),
                            ).put(
                                "role",
                                "phone",
                            ).put("signature", encoded(identity.sign(data)))
                            .apply {
                                requestId?.let { put("requestId", it) }
                                if (!registrationOnly) accessGeneration?.let { put("generation", it) }
                                if (registrationOnly) put("mode", "registration")
                            }.toString(),
                    )
                }
                "authenticated" -> {
                    if (registrationOnly && accessGeneration != null) {
                        webSocket.send(
                            JSONObject()
                                .put("type", "setAccess")
                                .put("enabled", accessEnabled)
                                .put("generation", accessGeneration)
                                .toString(),
                        )
                    } else {
                        sendRegistration(webSocket)
                    }
                    report("Waiting for your device")
                }
                "accessUpdated" -> {
                    if (removePush) {
                        webSocket.send(JSONObject().put("type", "unregisterPush").toString())
                    } else if (fid != null) {
                        webSocket.send(JSONObject().put("type", "registerPush").put("fid", fid).toString())
                    }
                }
                "pushRegistered" -> report("Remote wake ready")
                "pushRemoved" -> report("Remote wake disabled")
                "ready" -> {
                    check(!ready)
                    check(admit())
                    ready = true
                    report("Device connected; securing session")
                }
                else -> error("Invalid relay message")
            }
        } catch (_: Exception) {
            close()
            report("Connection rejected. Review this device’s access in Devices.")
        }
    }

    @Synchronized
    override fun onMessage(
        webSocket: WebSocket,
        bytes: ByteString,
    ) {
        try {
            check(active.get() && current() && ready)
            val input = bytes.toByteArray()
            val current = channel
            if (current != null) {
                val plaintext = current.open(input)
                try {
                    val existing = control
                    if (existing != null) {
                        existing.receive(plaintext)
                        return
                    }
                    if (!plaintext.contentEquals("Encrypted connection check 🌞".toByteArray(Charsets.UTF_8))) {
                        require(context != null && ControlCommand.decode(plaintext).op == 1)
                        startSession?.invoke() ?: SessionService.start(context)
                        onControl()
                        direct?.close()
                        direct = null
                        control =
                            ControlSession(
                                context,
                                grant.getString("id"),
                                { active.get() && this.current() },
                                ::sendControl,
                                ::offerDirect,
                            )
                        report("Remote control connected")
                        control!!.receive(plaintext)
                        return
                    }
                    // A check reserves one bounded preparation window, never a renewable keepalive.
                    check(!checked)
                    checked = true
                    webSocket.send(current.seal(plaintext).toByteString())
                    features?.let { report ->
                        check(active.get() && this.current())
                        webSocket.send(current.seal(report().toString().toByteArray(Charsets.UTF_8)).toByteString())
                    }
                    report("Encrypted connection passed")
                } finally {
                    plaintext.fill(0)
                }
            } else {
                val pending = handshake
                if (pending == null) {
                    val auth =
                        Authority(unhex(grant.getString("id"), 16), 1, decoded(grant.getString("viewer"))) { active.get() && current() }
                    handshake = PhoneHandshake.start(identity, auth, input).also { webSocket.send(it.offer.toByteString()) }
                } else {
                    val result = pending.finish(input)
                    channel = result.second
                    webSocket.send(result.first.toByteString())
                    report("Encrypted session established")
                }
            }
        } catch (_: Exception) {
            close()
            report("Encrypted session rejected")
        }
    }

    @Synchronized
    private fun offerDirect(
        sdp: String,
        reply: (String?) -> Unit,
    ) {
        val app = context ?: return reply(null)
        direct?.close()
        val link =
            dev.remoteaccess.app.transport.DirectLink(app, identity, grant, { active.get() && current() }) {
                synchronized(this) {
                    control?.close()
                    control = null
                }
            }
        direct = link
        link.offer(sdp, reply)
    }

    @Synchronized
    private fun sendControl(bytes: ByteArray) {
        try {
            check(active.get() && current())
            val ws = checkNotNull(socket)
            check(ws.queueSize() <= 1048608)
            check(ws.send(checkNotNull(channel).seal(bytes).toByteString()))
        } catch (_: Exception) {
            close()
            report("Connection closed. Reconnect to continue.")
        }
    }

    private fun sendRegistration(webSocket: WebSocket) {
        if (removePush) {
            webSocket.send(JSONObject().put("type", "unregisterPush").toString())
        } else if (fid != null) {
            webSocket.send(JSONObject().put("type", "registerPush").put("fid", fid).toString())
        }
    }

    override fun onFailure(
        webSocket: WebSocket,
        t: Throwable,
        response: Response?,
    ) {
        if (!active.get()) return
        close()
        report("Connection closed. Tap Connect to try again.")
    }

    override fun onClosing(
        webSocket: WebSocket,
        code: Int,
        reason: String,
    ) {
        if (!active.get()) return
        webSocket.close(code, null)
        close()
        report("Connection closed. Tap Connect to try again.")
    }
}

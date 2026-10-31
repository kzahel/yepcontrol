package com.yepcontrol.mediaspike

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object Probe {
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private lateinit var context: Context
    private var expiry = 0L

    fun connect(
        ctx: Context,
        port: Int,
        token: String,
    ) {
        if (socket != null) return
        context = ctx
        expiry = android.os.SystemClock.elapsedRealtime() + 120_000
        val client = OkHttpClient.Builder().pingInterval(10, TimeUnit.SECONDS).build()
        socket =
            client.newWebSocket(
                Request
                    .Builder()
                    .url("ws://127.0.0.1:$port/phone")
                    .header("Authorization", "Bearer $token")
                    .build(),
                object : WebSocketListener() {
                    override fun onOpen(
                        webSocket: WebSocket,
                        response: Response,
                    ) {
                        event("connected")
                    }

                    override fun onMessage(
                        webSocket: WebSocket,
                        text: String,
                    ) {
                        main.post {
                            try {
                                val message = JSONObject(text)
                                command(message.getString("command"))
                            } catch (error: Exception) {
                                event("error", error.javaClass.simpleName)
                            }
                        }
                    }

                    override fun onFailure(
                        webSocket: WebSocket,
                        t: Throwable,
                        response: Response?,
                    ) {
                        main.post { end() }
                    }

                    override fun onClosed(
                        webSocket: WebSocket,
                        code: Int,
                        reason: String,
                    ) {
                        main.post { end() }
                    }

                    override fun onClosing(
                        webSocket: WebSocket,
                        code: Int,
                        reason: String,
                    ) {
                        main.post { end() }
                    }
                },
            )
        main.postDelayed({ end() }, 120_000)
        client.dispatcher.executorService.shutdown()
    }

    fun command(command: String) {
        if (!::context.isInitialized || android.os.SystemClock.elapsedRealtime() >= expiry) return
        try {
            when (command) {
                "arm" -> context.startForegroundService(Intent(context, CaptureService::class.java))
                "show" -> checkNotNull(ProbeAccessService.instance) { "accessibility not bound" }.showRequest()
                "camera" -> checkNotNull(CaptureService.instance) { "not armed" }.camera()
                "microphone" -> checkNotNull(CaptureService.instance) { "not armed" }.microphone()
                "off" -> CaptureService.instance?.off()
                "disarm" -> context.stopService(Intent(context, CaptureService::class.java))
                "status" ->
                    event(
                        "status",
                        "armed=${CaptureService.instance != null}; accessibilityBound=${ProbeAccessService.instance != null}",
                    )
                else -> error("unknown command")
            }
        } catch (error: Exception) {
            event("error", "$command: ${error.javaClass.simpleName}: ${error.message}")
        }
    }

    fun event(
        name: String,
        detail: String = "",
    ) {
        socket?.send(JSONObject().put("event", name).put("detail", detail).toString())
    }

    // Bounded transport: drop media when queued; sensors are never saved to disk.
    fun media(
        kind: Int,
        bytes: ByteArray,
    ) {
        val link = socket ?: return
        if (link.queueSize() < 256 * 1024) link.send((byteArrayOf(kind.toByte()) + bytes).toByteString())
    }

    fun end() {
        expiry = 0
        if (::context.isInitialized) context.stopService(Intent(context, CaptureService::class.java))
        socket?.cancel()
        socket = null
    }
}

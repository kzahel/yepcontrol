package dev.remoteaccess.app.media

import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.remoteaccess.app.HostRuntime
import dev.remoteaccess.app.HostStore
import dev.remoteaccess.app.MainActivity
import dev.remoteaccess.app.R
import dev.remoteaccess.app.control.ScreenAccessService
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Sensor-only control fixture. No instrumentation privileges or release manifest entry. */
class MediaFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        layout.addView(TextView(this).apply { setText(R.string.media_fixture_description) })
        layout.addView(
            Button(this).apply {
                setText(R.string.media_fixture_settings)
                setOnClickListener { startActivity(Intent(this@MediaFixtureActivity, MainActivity::class.java)) }
            },
        )
        layout.addView(
            Button(this).apply {
                setText(R.string.media_fixture_stop)
                setOnClickListener { MediaController.close() }
            },
        )
        setContentView(layout)
        val token = intent.getStringExtra("token").orEmpty()
        val port = intent.getIntExtra("port", 0)
        if (token.matches(Regex("[0-9a-f]{64}")) && port in 1024..65535) Bridge.connect(applicationContext, port, token)
    }
}

private object Bridge {
    private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    private var socket: WebSocket? = null

    @Volatile private var owner = Any()

    @Volatile private var access = true
    private val used = mutableSetOf<Int>()

    fun connect(
        context: android.content.Context,
        port: Int,
        token: String,
    ) {
        MediaController.close(owner, reason = 5)
        socket?.cancel()
        owner = Any()
        val scope = owner
        used.clear()
        access = true
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
                        HostRuntime.io.execute {
                            HostStore.get(context).load()
                            MediaController.main.post { if (owner === scope) state(context) }
                        }
                    }

                    override fun onMessage(
                        webSocket: WebSocket,
                        text: String,
                    ) {
                        MediaController.main.post {
                            if (owner !== scope) return@post
                            runCatching {
                                val command = JSONObject(text)
                                val id = command.optInt("id", 0)
                                val op = command.getString("op")
                                var code = 0
                                when (op) {
                                    "state" -> {
                                        state(context)
                                        return@post
                                    }
                                    "camera", "microphone" -> {
                                        check(id > 0)
                                        if (used.size >= 1024 || !used.add(id)) {
                                            code = 4
                                        } else {
                                            val result =
                                                MediaController.prepare(
                                                    context,
                                                    scope,
                                                    "Sensor acceptance",
                                                    id,
                                                    op == "camera",
                                                    command.optInt("facing", 1),
                                                    command.optInt("format", 1),
                                                    command.optInt("fps", 1),
                                                    {
                                                        owner === scope &&
                                                            access &&
                                                            HostStore
                                                                .get(context)
                                                                .snapshot.settings.armed
                                                    },
                                                    { record ->
                                                        webSocket.queueSize() < 262144 &&
                                                            webSocket.send(record.encode().toByteString())
                                                    },
                                                )
                                            code = result.first
                                            webSocket.send(
                                                JSONObject()
                                                    .put("op", op)
                                                    .put("id", id)
                                                    .put("code", code)
                                                    .toString(),
                                            )
                                            result.second?.activate()
                                            return@post
                                        }
                                    }
                                    "notificationStop" -> {
                                        val notices =
                                            context
                                                .getSystemService(NotificationManager::class.java)
                                                .activeNotifications
                                                .filter { it.id in listOf(104, 105) }
                                        check(notices.size == 2)
                                        val action =
                                            notices
                                                .first()
                                                .notification.actions
                                                .single { it.title.toString() == "Stop sharing" }
                                        check(action.actionIntent.creatorPackage == context.packageName)
                                        webSocket.send(
                                            JSONObject()
                                                .put("op", op)
                                                .put("code", 0)
                                                .put("notifications", notices.size)
                                                .put("action", action.title.toString())
                                                .put("creator", action.actionIntent.creatorPackage)
                                                .toString(),
                                        )
                                        // Deliver the exact PendingIntent held by the production notification.
                                        action.actionIntent.send()
                                        return@post
                                    }
                                    "renew" -> if (!MediaController.renew(scope, id)) code = 4
                                    "stop" -> MediaController.close(scope, id)
                                    "access" -> {
                                        access = command.getBoolean("value")
                                    }
                                    "setting" -> {
                                        HostRuntime.io.execute {
                                            val store = HostStore.get(context)
                                            if (command.getBoolean("camera")) {
                                                store.media(cameraAllowed = command.getBoolean("value"))
                                            } else {
                                                store.media(microphoneAllowed = command.getBoolean("value"))
                                            }
                                            MediaController.main.post { if (owner === scope) state(context) }
                                        }
                                        return@post
                                    }
                                    else -> error("Unknown fixture command")
                                }
                                webSocket.send(
                                    JSONObject()
                                        .put("op", op)
                                        .put("id", id)
                                        .put("code", code)
                                        .toString(),
                                )
                            }.onFailure {
                                webSocket.close(1008, "Invalid command")
                                MediaController.close(scope, reason = 5)
                            }
                        }
                    }

                    override fun onClosing(
                        webSocket: WebSocket,
                        code: Int,
                        reason: String,
                    ) {
                        MediaController.close(scope, reason = 5)
                        webSocket.close(code, reason)
                    }

                    override fun onClosed(
                        webSocket: WebSocket,
                        code: Int,
                        reason: String,
                    ) {
                        MediaController.close(scope, reason = 5)
                    }

                    override fun onFailure(
                        webSocket: WebSocket,
                        t: Throwable,
                        response: Response?,
                    ) {
                        MediaController.close(scope, reason = 5)
                    }
                },
            )
        // Independent outer bound if the acceptance runner disappears without a clean socket close.
        MediaController.main.postDelayed({
            if (owner ===
                scope
            ) {
                MediaController.close(scope)
                socket?.close(1000, "Fixture deadline")
            }
        }, 600000)
    }

    private fun state(context: android.content.Context) {
        socket?.send(
            JSONObject()
                .put("op", "state")
                .put("media", MediaController.state(context, owner))
                .put("bound", ScreenAccessService.current != null)
                .toString(),
        )
    }
}

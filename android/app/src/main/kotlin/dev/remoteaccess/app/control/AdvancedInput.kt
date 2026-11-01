package dev.remoteaccess.app.control

import android.content.Context
import android.os.Handler
import dev.remoteaccess.app.advanced.AdvancedControl
import dev.remoteaccess.protocol.TouchBatch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

/** One ordered raw-input stream. Failures never replay a packet through accessibility. */
internal class AdvancedInput(
    private val context: Context,
    private val main: Handler,
) {
    private val worker = Executors.newSingleThreadExecutor()
    private var owner: Any? = null
    private var token = ""
    private var sequence = -1
    private var gesture = 0
    private var scene = 0

    @Volatile private var revision = 0
    private var lastPacket = 0L
    private var permitted: () -> Boolean = { false }
    var dispatching = false
        private set
    val active get() = owner != null
    private val watchdog =
        object : Runnable {
            override fun run() {
                if (!active) return
                if (!AdvancedControl.ready() ||
                    !permitted() ||
                    android.os.SystemClock.elapsedRealtime() - lastPacket > 700
                ) {
                    release()
                } else {
                    main.postDelayed(this, 100)
                }
            }
        }

    fun accept(
        batch: TouchBatch,
        who: Any,
        width: Int,
        height: Int,
        currentScene: Int,
        allowed: () -> Boolean,
        reply: (Int) -> Unit,
    ) {
        if (dispatching) return reply(6)
        if (!AdvancedControl.ready() ||
            batch.scene != currentScene ||
            (active && (owner !== who || batch.sequence != sequence + 1 || batch.gesture != gesture || scene != currentScene)) ||
            (!active && batch.sequence != 0) ||
            batch.contacts.any { c -> c.path.any { it.x >= width || it.y >= height } }
        ) {
            release()
            return reply(2)
        }
        if (!active) {
            owner = who
            token = UUID.randomUUID().toString()
            main.postDelayed(watchdog, 100)
        }
        sequence = batch.sequence
        gesture = batch.gesture
        scene = currentScene
        permitted = allowed
        lastPacket = android.os.SystemClock.elapsedRealtime()
        val packet =
            JSONObject()
                .put("owner", token)
                .put("sequence", sequence)
                .put("gesture", gesture)
                .put("scene", scene)
                .put("duration", batch.duration)
                .put(
                    "contacts",
                    JSONArray().apply {
                        batch.contacts.forEach { c ->
                            put(
                                JSONObject().put("id", c.id).put("held", c.held).put(
                                    "path",
                                    JSONArray().apply {
                                        c.path.forEach { p -> put(JSONArray().put(p.x).put(p.y)) }
                                    },
                                ),
                            )
                        }
                    },
                )
        val expected = revision
        dispatching = true
        worker.execute {
            val code =
                if (!allowed() || revision != expected) {
                    8
                } else {
                    runCatching {
                        AdvancedControl.touch(context, packet)
                        0
                    }.getOrDefault(7)
                }
            main.post {
                dispatching = false
                if (expected != revision) return@post reply(7)
                if (code != 0 || !allowed()) {
                    release()
                    reply(if (code != 0) code else 8)
                } else {
                    if (batch.contacts.none { it.held }) clear()
                    reply(0)
                }
            }
        }
    }

    fun stroke(
        who: Any,
        x: Int,
        y: Int,
        endX: Int,
        endY: Int,
        duration: Int,
        allowed: () -> Boolean,
        reply: (Int) -> Unit,
    ) {
        if (dispatching || active) return reply(6)
        dispatching = true
        val expected = revision
        val key = UUID.randomUUID().toString()
        owner = who
        worker.execute {
            val code =
                runCatching {
                    var elapsed = 0
                    var seq = 0
                    while (elapsed < duration) {
                        check(revision == expected && allowed() && AdvancedControl.ready())
                        val length = minOf(100, duration - elapsed).coerceAtLeast(16)
                        val end = minOf(duration, elapsed + length)

                        fun point(at: Int) =
                            JSONArray().put(x + (endX - x) * at.toDouble() / duration).put(
                                y + (endY - y) * at.toDouble() / duration,
                            )
                        AdvancedControl.touch(
                            context,
                            JSONObject()
                                .put("owner", key)
                                .put("sequence", seq++)
                                .put("gesture", 1)
                                .put("scene", 1)
                                .put("duration", length)
                                .put(
                                    "contacts",
                                    JSONArray().put(
                                        JSONObject()
                                            .put("id", 0)
                                            .put("held", end < duration)
                                            .put("path", JSONArray().put(point(elapsed)).put(point(end))),
                                    ),
                                ),
                        )
                        elapsed = end
                    }
                    0
                }.getOrDefault(7)
            if (code != 0) AdvancedControl.cancel(context)
            main.post {
                dispatching = false
                if (expected == revision) clear()
                reply(if (code == 0 && allowed()) 0 else 7)
            }
        }
    }

    fun release(who: Any? = null) {
        if (!active && !dispatching) return
        if (who != null && owner !== who) return
        revision++
        clear()
        worker.execute { AdvancedControl.cancel(context) }
    }

    fun close() {
        release()
        worker.shutdown()
    }

    private fun clear() {
        owner = null
        token = ""
        sequence = -1
        main.removeCallbacks(watchdog)
    }
}

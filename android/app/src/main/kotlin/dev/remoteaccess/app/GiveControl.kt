package dev.remoteaccess.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.lifecycle.ViewModel
import dev.remoteaccess.protocol.Crypto
import dev.remoteaccess.protocol.Identity
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** The local Show code action approves one authenticated QR holder, in memory only. */
internal class GiveControl : ViewModel() {
    enum class Phase { IDLE, CREATING, WAITING, CONNECTING, COMPLETED, FAILED }

    data class State(
        val phase: Phase = Phase.IDLE,
        val link: String? = null,
        val deviceId: String? = null,
    )

    private class Session(
        val origin: String,
    ) {
        val id = randomHex(16)
        val secret = randomHex(32)

        @Volatile var active = true

        @Volatile var identity: Identity? = null

        @Volatile var completed = false
        var store: HostStore? = null
    }

    private val lock = Any()
    private val executor = Executors.newFixedThreadPool(2)
    private val main = Handler(Looper.getMainLooper())
    private var current: Session? = null
    val listeners = mutableSetOf<() -> Unit>()

    @Volatile var state = State()
        private set

    private fun publish(value: State) {
        state = value
        main.post { listeners.toList().forEach { it() } }
    }

    fun begin(context: Context) {
        val app = context.applicationContext
        val session =
            synchronized(lock) {
                if (current != null) return
                Session(Website.current(app)).also {
                    current = it
                    publish(State(Phase.CREATING))
                }
            }
        executor.execute { run(app, session) }
    }

    fun cancel() {
        val session =
            synchronized(lock) {
                val active = current ?: return
                active.active = false
                current = null
                publish(State())
                active
            }
        executor.execute { cleanup(session) }
    }

    fun consumed() {
        if (state.phase == Phase.COMPLETED) publish(State())
    }

    private fun run(
        context: Context,
        session: Session,
    ) {
        try {
            val store = HostStore.get(context).load()
            session.store = store
            check(store.snapshot.devices.size < 32)
            val identity = KeystoreIdentity.loadOrCreate("phone-identity-v1")
            session.identity = identity
            val time = serviceRequest(session.origin, "/api/pairing-time")
            val serverTime = time.getLong("serverTime")
            val expires = time.getLong("expires")
            val remaining = expires * 1000 - serverTime
            require(remaining in 1..300000)
            val received = SystemClock.elapsedRealtime()
            val now = { serverTime + SystemClock.elapsedRealtime() - received }
            val phone = encoded(identity.publicKey)
            check(session.active)
            request(
                session.origin,
                session.id,
                "invite",
                JSONObject()
                    .put("phone", phone)
                    .put("expires", expires)
                    .put(
                        "signature",
                        encoded(identity.sign(fields("ara/pair/phone-create/v1", session.origin, session.id, phone, expires))),
                    ),
            )
            val invite =
                JSONObject()
                    .put("v", 1)
                    .put("origin", session.origin)
                    .put("id", session.id)
                    .put("phone", phone)
                    .put("expires", expires)
                    .put("secret", session.secret)
            synchronized(lock) {
                check(current === session && session.active)
                publish(State(Phase.WAITING, "${session.origin}/control#${encoded(invite.toString().toByteArray(Charsets.UTF_8))}"))
            }
            while (session.active && now() < expires * 1000) {
                val result =
                    try {
                        request(session.origin, session.id, seen = "inviting")
                    } catch (error: IOException) {
                        if (error is PairingHttpError && error.status != 429 && error.status < 500) throw error
                        val pause = minOf(expires * 1000 - now(), (error as? PairingHttpError)?.retryAfter ?: 1000)
                        val until = SystemClock.elapsedRealtime() + pause
                        while (session.active &&
                            SystemClock.elapsedRealtime() < until
                        ) {
                            Thread.sleep(minOf(250, until - SystemClock.elapsedRealtime()).coerceAtLeast(1))
                        }
                        continue
                    }
                check(session.active)
                if (result.getString("state") == "claimed") {
                    val claim = result.getJSONObject("claim")
                    val name = claim.getString("name")
                    require(validDeviceName(name))
                    val viewer = claim.getString("viewer")
                    val bytes = fields("ara/pair/phone-claim/v1", session.origin, session.id, phone, expires, viewer, name)
                    val mac =
                        Mac.getInstance("HmacSHA256").run {
                            init(SecretKeySpec(unhex(session.secret, 32), "HmacSHA256"))
                            doFinal(bytes)
                        }
                    require(MessageDigest.isEqual(mac, unhex(claim.getString("mac"), 32)))
                    Crypto.verify(decoded(viewer), bytes, decoded(claim.getString("signature")))
                    synchronized(lock) {
                        check(current === session && session.active)
                        publish(State(Phase.CONNECTING))
                    }
                    val legacy =
                        JSONObject(invite.toString()).apply {
                            remove("phone")
                            put("viewer", viewer)
                            put("name", name)
                        }
                    val enrollment =
                        Enrollment(
                            "${session.origin}/enroll#${encoded(legacy.toString().toByteArray(Charsets.UTF_8))}",
                            session.origin,
                            now,
                        )
                    val accepted = enrollment.grant(identity, DeviceInfo.report(context)) { !session.active }
                    synchronized(lock) {
                        check(current === session && session.active)
                        val device = store.pair(accepted, name)
                        session.completed = true
                        current = null
                        publish(State(Phase.COMPLETED, deviceId = device.id))
                    }
                    WakeSupport.enqueue(context, androidx.work.Data.EMPTY, registration = true)
                    return
                }
                Thread.sleep(750)
            }
            error("Code expired")
        } catch (_: Exception) {
            synchronized(lock) {
                if (current === session) {
                    current = null
                    session.active = false
                    publish(State(Phase.FAILED))
                }
            }
        } finally {
            if (!session.completed) cleanup(session)
        }
    }

    private fun cleanup(session: Session) {
        if (session.completed) return
        try {
            session.store?.let { store ->
                synchronized(lock) { if (!session.completed && store.device(session.id)?.revoked == false) store.revoke(session.id) }
            }
            val identity = session.identity ?: return
            request(
                session.origin,
                session.id,
                "revoke",
                JSONObject().put("signature", encoded(identity.sign(fields("ara/pair/revoke/v1", session.origin, session.id)))),
            )
        } catch (_: Exception) {
            // No active invitation may store authority after cancellation. The relay code expires.
        }
    }

    override fun onCleared() {
        cancel()
        executor.shutdown()
    }

    companion object {
        private fun randomHex(size: Int) = ByteArray(size).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    }
}

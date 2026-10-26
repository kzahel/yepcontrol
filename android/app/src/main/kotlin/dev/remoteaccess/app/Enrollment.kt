package dev.remoteaccess.app

import dev.remoteaccess.protocol.Crypto
import dev.remoteaccess.protocol.DeviceSeal
import dev.remoteaccess.protocol.Identity
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal fun encoded(value: ByteArray): String = Base64.getEncoder().encodeToString(value)

internal fun decoded(value: String): ByteArray = Base64.getDecoder().decode(value)

internal fun fields(vararg values: Any): ByteArray {
    require(values.none { it.toString().contains('\n') })
    return values.joinToString("\n").toByteArray(Charsets.UTF_8)
}

internal fun unhex(
    value: String,
    size: Int,
): ByteArray {
    require(value.matches(Regex("[0-9a-f]{${size * 2}}")))
    return value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}

internal fun grantBytes(
    origin: String,
    grant: JSONObject,
): ByteArray =
    fields(
        "ara/pair/grant/v1",
        origin,
        grant.getString("id"),
        grant.getString("viewer"),
        grant.getString("phone"),
        grant.getLong("expires"),
    )

internal val http =
    OkHttpClient
        .Builder()
        .addInterceptor { chain ->
            val original = chain.request()
            val request =
                if (BuildConfig.DEBUG && BuildConfig.PROOF_RELAY && original.url.toString().startsWith("${BuildConfig.SHARING_WEBSITE}/")) {
                    original.newBuilder().header("X-Proof-Key", BuildConfig.PROOF_RELAY_KEY).build()
                } else {
                    original
                }
            chain.proceed(request)
        }.connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

internal fun request(
    origin: String,
    id: String,
    action: String = "",
    body: JSONObject? = null,
    seen: String? = null,
): JSONObject = serviceRequest(origin, "/api/pair/$id" + if (action.isEmpty()) "" else "/$action", body, seen)

internal fun serviceRequest(
    origin: String,
    path: String,
    body: JSONObject? = null,
    seen: String? = null,
): JSONObject {
    Website.requireConfigured(origin)
    val url = "$origin$path"
    val request = Request.Builder().url(url)
    // The relay holds this poll until the pairing state differs from `seen`.
    if (seen != null) request.header("Pair-Wait", seen)
    if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
    return http.newCall(request.build()).execute().use {
        if (!it.isSuccessful) {
            throw PairingHttpError(
                it.code,
                (it.header("Retry-After")?.toLongOrNull() ?: if (it.code == 429) 60 else 1).coerceIn(1, 300) * 1000,
            )
        }
        val source = it.body
        require(source.contentLength() <= 8192)
        val buffer = ByteArray(8193)
        var size = 0
        val stream = source.byteStream()
        while (size < buffer.size) {
            val count = stream.read(buffer, size, buffer.size - size)
            if (count < 0) break
            size += count
        }
        require(size <= 8192)
        JSONObject(buffer.copyOf(size).toString(Charsets.UTF_8))
    }
}

internal fun validDeviceName(name: String) =
    name == name.trim() &&
        name.length in 1..40 &&
        name.none {
            it.isISOControl() || it.category in setOf(CharCategory.FORMAT, CharCategory.LINE_SEPARATOR, CharCategory.PARAGRAPH_SEPARATOR)
        }

internal class PairingHttpError(
    val status: Int,
    val retryAfter: Long,
) : IOException("Pairing unavailable ($status)")

internal class EnrollmentOriginMismatch : IllegalArgumentException()

internal class Enrollment(
    uri: String,
    expectedOrigin: String,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val invite: JSONObject
    val origin: String

    /** Label chosen by the pairing device (e.g. "Chrome on macOS"); a convenience, never proof of identity. */
    val name: String

    init {
        Website.requireConfigured(expectedOrigin)
        require(uri.length < 4096)
        val link = URI(uri)
        require(
            link.scheme == "https" &&
                link.host != null &&
                link.rawUserInfo == null &&
                link.rawQuery == null &&
                link.rawPath == "/enroll" &&
                link.rawFragment != null,
        )
        if (link.scheme + "://" + link.rawAuthority != expectedOrigin) throw EnrollmentOriginMismatch()
        invite = JSONObject(decoded(link.rawFragment).toString(Charsets.UTF_8))
        require(invite.getInt("v") == 1)
        origin = invite.getString("origin")
        val url = URI(origin)
        require(
            url.scheme == "https" &&
                url.host != null &&
                url.rawUserInfo == null &&
                url.rawQuery == null &&
                url.rawFragment == null &&
                url.rawPath.isEmpty(),
        )
        if (origin != expectedOrigin) throw EnrollmentOriginMismatch()
        name = invite.getString("name")
        require(validDeviceName(name))
        unhex(invite.getString("id"), 16)
        unhex(invite.getString("secret"), 32)
        Crypto.publicKey(decoded(invite.getString("viewer")))
        checkTime()
    }

    private fun checkTime() {
        val remaining = invite.getLong("expires") * 1000 - now()
        require(remaining in 1..301000) { "Pairing code expired" }
    }

    fun grant(
        identity: Identity,
        device: JSONObject,
        cancelled: () -> Boolean = { false },
    ): JSONObject {
        checkTime()
        val id = invite.getString("id")
        val grant =
            JSONObject()
                .put(
                    "id",
                    id,
                ).put("viewer", invite.getString("viewer"))
                .put("phone", encoded(identity.publicKey))
                .put("expires", invite.getLong("expires"))
        val data = grantBytes(origin, grant)
        val mac =
            Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(unhex(invite.getString("secret"), 32), "HmacSHA256"))
                doFinal(data).joinToString("") { "%02x".format(it) }
            }
        grant.put("phoneSignature", encoded(identity.sign(data))).put("mac", mac)
        // The device report travels sealed with the QR secret, so the relay cannot read it.
        val sealed = DeviceSeal.seal(unhex(invite.getString("secret"), 32), unhex(id, 16), device.toString().toByteArray())
        request(origin, id, "offer", JSONObject(grant.toString()).put("device", sealed))
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
        var seen = "offered"
        while (System.nanoTime() < deadline) {
            checkTime()
            check(!cancelled()) { "Cancelled" }
            val asked = System.nanoTime()
            val reply = request(origin, id, seen = seen)
            seen = reply.getString("state")
            if (seen == "paired") {
                val accepted = reply.getJSONObject("grant")
                require(grantBytes(origin, accepted).contentEquals(data))
                Crypto.verify(decoded(grant.getString("viewer")), data, decoded(accepted.getString("viewerSignature")))
                return accepted.put("origin", origin)
            }
            // A relay without held polls answers at once; keep the earlier pace.
            if (System.nanoTime() - asked < TimeUnit.MILLISECONDS.toNanos(500)) Thread.sleep(750)
        }
        error("The other device did not confirm pairing.")
    }
}

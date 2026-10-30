package dev.remoteaccess.protocol

import java.nio.ByteBuffer
import java.security.MessageDigest

/** Native target resolution may block; authority must be checked after it finishes. */
object SemanticGuard {
    inline fun <T> perform(
        resolve: () -> T,
        allowed: () -> Boolean,
        action: (T) -> Int,
    ): Int {
        val target = resolve()
        if (!allowed()) return 8
        return action(target)
    }

    /** Private fingerprint; wire labels may be truncated but target values may not. */
    fun fingerprint(fields: List<String>): String? {
        if (fields.any { it.length > 4096 }) return null
        val digest = MessageDigest.getInstance("SHA-256")
        for (field in fields) {
            val bytes = field.toByteArray(Charsets.UTF_8)
            digest.update(ByteBuffer.allocate(4).putInt(bytes.size).array())
            digest.update(bytes)
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}

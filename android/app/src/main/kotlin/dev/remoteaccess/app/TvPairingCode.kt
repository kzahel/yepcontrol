package dev.remoteaccess.app

import java.security.MessageDigest
import java.security.SecureRandom

/** 32 uniformly random Base32 symbols, each with five bits of entropy. */
internal class TvPairingCode(
    private val origin: String,
) {
    private val code = generate()

    private fun derive(purpose: String) =
        MessageDigest
            .getInstance("SHA-256")
            .digest(fields("ara/pair/tv-code/$purpose/v1", origin, code))

    val id = derive("id").copyOf(16).joinToString("") { "%02x".format(it) }
    val secret = derive("secret").joinToString("") { "%02x".format(it) }
    val display = code.chunked(4).joinToString("-")

    companion object {
        private fun generate(): String {
            val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
            val random = SecureRandom()
            return CharArray(32) { alphabet[random.nextInt(alphabet.length)] }.concatToString()
        }
    }
}

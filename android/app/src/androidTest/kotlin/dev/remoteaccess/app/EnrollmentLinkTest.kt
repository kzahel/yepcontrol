package dev.remoteaccess.app

import android.content.Intent
import androidx.core.net.toUri
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import dev.remoteaccess.protocol.Crypto
import dev.remoteaccess.protocol.JcaIdentity
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EnrollmentLinkTest {
    @get:Rule val failureDiagnostics = FixtureFailureDiagnostics()

    private val origin = BuildConfig.SHARING_WEBSITE
    private val identity = Crypto.generate().let { JcaIdentity(it.private, it.public) }
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun invitation(
        service: String = origin,
        name: String = "Chrome on macOS",
    ) = JSONObject()
        .put("v", 1)
        .put("origin", service)
        .put("id", "11".repeat(16))
        .put("secret", "22".repeat(32))
        .put("viewer", encoded(identity.publicKey))
        .put("expires", System.currentTimeMillis() / 1000 + 300)
        .put("name", name)

    private fun link(
        service: String = origin,
        name: String = "Chrome on macOS",
    ) = "$service/enroll#${encoded(invitation(service, name).toString().toByteArray(Charsets.UTF_8))}"

    @Test fun validatesHttpsOriginAndFragmentWithoutNetwork() {
        val fragment = encoded(invitation().toString().toByteArray(Charsets.UTF_8))
        assertEquals(origin, Enrollment(link(), origin).origin)
        assertEquals("Chrome on macOS", Enrollment(link(), origin).name)
        val pairingLink = link()
        val play = "https://play.google.com/store/apps/details?id=com.yepcontrol.app"
        val handoff =
            Intent.parseUri(
                "${pairingLink.replaceFirst(
                    "https:",
                    "intent:",
                )}#Intent;scheme=https;package=com.yepcontrol.app;S.browser_fallback_url=${android.net.Uri.encode(play)};end",
                Intent.URI_INTENT_SCHEME,
            )
        assertEquals(pairingLink, handoff.dataString, "Android handoff must preserve the complete invitation fragment")
        assertEquals("com.yepcontrol.app", handoff.`package`)
        assertEquals(play, handoff.getStringExtra("browser_fallback_url"))
        assertEquals(origin, Enrollment(requireNotNull(handoff.dataString), origin).origin)
        for (bad in listOf(
            "https://other.example/enroll#$fragment",
            "${origin.replaceFirst("https:", "http:")}/enroll#$fragment",
            "$origin/enroll?secret=leak#$fragment",
            "$origin/other#$fragment",
            "${origin.replaceFirst("://", "://user@")}/enroll#$fragment",
            "$origin/enroll",
            "ara-pair://enroll#$fragment",
        )) {
            assertFails { Enrollment(bad, origin) }
        }
    }

    @Test fun matchingAttackerOriginsAndNearMatchesAreRejected() {
        for (service in listOf(
            "https://other.example",
            "$origin.attacker.example",
            origin.replaceFirst("://", "://www."),
            origin.replaceFirst("://", "://subdomain."),
            "$origin:4443",
            "$origin.",
        )) {
            assertFailsWith<EnrollmentOriginMismatch>(service) { Enrollment(link(service), origin) }
        }
        val mismatched = encoded(invitation("https://other.example").toString().toByteArray(Charsets.UTF_8))
        assertFailsWith<EnrollmentOriginMismatch> { Enrollment("$origin/enroll#$mismatched", origin) }
        assertFails { Enrollment(link("https://other.example"), "https://other.example") }
    }

    @Test fun developmentRequiresExplicitConfigurationAndSelection() {
        val preferences = context.getSharedPreferences("website", android.content.Context.MODE_PRIVATE)
        val previous = preferences.getBoolean("development", false)
        try {
            preferences.edit().putBoolean("development", false).commit()
            assertEquals(origin, Website.current(context))
            assertTrue(Website.accepts(origin))
            if (Website.developmentAvailable) {
                val development = BuildConfig.DEV_SHARING_WEBSITE
                assertTrue(BuildConfig.DEBUG)
                assertFailsWith<EnrollmentOriginMismatch> { Enrollment(link(development), Website.current(context)) }
                Website.setDevelopment(context, true)
                assertEquals(development, Website.current(context))
                assertEquals(development, Enrollment(link(development), Website.current(context)).origin)
                assertFailsWith<EnrollmentOriginMismatch> { Enrollment(link(), Website.current(context)) }
                // The switch governs new enrollment; already pinned grants on either configured service survive it.
                assertTrue(Website.accepts(origin))
                assertTrue(Website.accepts(development))
            } else {
                assertFails { Website.setDevelopment(context, true) }
                preferences.edit().putBoolean("development", true).commit()
                assertEquals(origin, Website.current(context))
                assertFalse(Website.accepts("https://development.example"))
            }
        } finally {
            preferences.edit().putBoolean("development", previous).commit()
        }
    }

    @Test fun labelsRejectInvisibleFormattingAndMultilineText() {
        for (name in listOf(
            "",
            " Chrome",
            "Chrome ",
            "a".repeat(41),
            "Chrome\nmacOS",
            "Chrome\tmacOS",
            "Chrome\u202emacOS",
            "Chrome\u200bmacOS",
            "Chrome\u2028macOS",
            "Chrome\u2029macOS",
        )) {
            assertFails { Enrollment(link(name = name), origin) }
        }
        assertEquals("Firefox on José’s laptop", Enrollment(link(name = "Firefox on José’s laptop"), origin).name)
    }

    @Test fun networkEntrypointsRejectUnconfiguredOriginsBeforeConnecting() {
        assertFailsWith<IllegalArgumentException> { request("https://other.example", "11".repeat(16)) }
        val connection = RelayConnection(identity, invitation("https://other.example"), {})
        try {
            assertFailsWith<IllegalArgumentException> { connection.connect() }
        } finally {
            connection.close()
        }
    }

    @Test fun incomingLinksShowThePinnedServiceAndRejectOtherServices() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim(), "Owned emulator only")
        val expected = Website.current(context)

        fun open(
            uri: String,
            reuse: Boolean = false,
        ) {
            val flag = if (reuse) Intent.FLAG_ACTIVITY_SINGLE_TOP else Intent.FLAG_ACTIVITY_CLEAR_TASK
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .setData(uri.toUri())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or flag),
            )
        }
        open(link(expected))
        assertTrue(device.wait(Until.hasObject(By.res("${context.packageName}:id/grant_device")), 10000))
        assertTrue(device.hasObject(By.text(expected.removePrefix("https://"))))
        assertTrue(device.hasObject(By.textStartsWith("This name is supplied by the other device.")))
        // Exercise onNewIntent while a valid approval is still visible: it must not remain usable.
        open(link("https://other.example"), reuse = true)
        assertTrue(device.wait(Until.hasObject(By.text("Use a pairing code from $expected.")), 10000))
        assertFalse(device.hasObject(By.res("${context.packageName}:id/grant_device")))
    }
}

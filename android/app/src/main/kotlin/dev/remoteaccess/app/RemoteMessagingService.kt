package dev.remoteaccess.app

import androidx.work.Data
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.remoteaccess.protocol.WakeHint

// Firebase 25.1 uses installation registration, rather than legacy token refresh.
@android.annotation.SuppressLint("MissingFirebaseInstanceTokenRefresh")
class RemoteMessagingService : FirebaseMessagingService() {
    override fun onRegistered(installationId: String) {
        if (!installationId.matches(Regex("[cdef][A-Za-z0-9_-]{21}"))) return
        WakeSupport.preferences(this).save {
            putString("fid", installationId)
            remove("registrationIssue")
        }
        HostRuntime.io.execute {
            HostStore.get(this).load()
            if (WakeSupport.allowed(this)) WakeSupport.enqueue(this, Data.EMPTY, registration = true)
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val hint = WakeHint.parse(message.data, System.currentTimeMillis()) ?: return
        val id = hint.pairingId ?: return
        val generation = hint.generation ?: return
        HostRuntime.io.execute {
            val store = HostStore.get(this).load()
            if (!WakeSupport.allowed(this) || !store.allowed(id, generation, automatic = true)) return@execute
            // A hint selects a locally pinned grant; it is never authority itself.
            WakeSupport.notify(this, "Your paired device is contacting this phone")
            WakeSupport.preferences(this).save { putLong("lastPushReceipt", System.currentTimeMillis()) }
            WakeSupport.enqueue(
                this,
                Data
                    .Builder()
                    .putString("pairingId", id)
                    .putString("generation", generation)
                    .putString("requestId", hint.requestId)
                    .putLong("expires", hint.expires)
                    .build(),
            )
        }
    }
}

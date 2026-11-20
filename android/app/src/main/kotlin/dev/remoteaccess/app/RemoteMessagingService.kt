package dev.remoteaccess.app

import android.os.PowerManager
import android.util.Log
import androidx.work.Data
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.remoteaccess.protocol.WakeHint

// Firebase 25.1 uses installation registration, rather than legacy token refresh.
@android.annotation.SuppressLint("MissingFirebaseInstanceTokenRefresh")
class RemoteMessagingService : FirebaseMessagingService() {
    override fun onRegistered(installationId: String) {
        if (!installationId.matches(Regex("[cdef][A-Za-z0-9_-]{21}"))) return
        Log.i(WakeSupport.LOG_TAG, "registration_received")
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
        val data = message.data
        if (data["intent"] != "connect-v1") return
        val now = System.currentTimeMillis()
        val hint = WakeHint.parse(data, now)
        val id = hint?.pairingId
        val generation = hint?.generation
        if (hint == null || id == null || generation == null) {
            Log.i(WakeSupport.LOG_TAG, "push_ignored reason=invalid_or_expired_hint")
            return
        }
        val power = getSystemService(PowerManager::class.java)
        Log.i(
            WakeSupport.LOG_TAG,
            "push_received remainingMs=${hint.expires * 1000 - now} priority=${message.priority} " +
                "originalPriority=${message.originalPriority} interactive=${power.isInteractive} idle=${power.isDeviceIdleMode}",
        )
        HostRuntime.io.execute {
            val store = HostStore.get(this).load()
            if (!WakeSupport.allowed(this) || !store.allowed(id, generation, automatic = true)) {
                Log.i(WakeSupport.LOG_TAG, "push_ignored reason=local_access")
                return@execute
            }
            // A hint selects a locally pinned grant; it is never authority itself.
            WakeSupport.notify(this, "Your paired device is contacting this phone")
            WakeSupport.preferences(this).save { putLong("lastPushReceipt", System.currentTimeMillis()) }
            Log.i(WakeSupport.LOG_TAG, "wake_enqueuing")
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

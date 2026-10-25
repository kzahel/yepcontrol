package dev.remoteaccess.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

internal object WakeSupport {
    const val CHANNEL = "remote-connections"
    const val NOTIFICATION = 100
    const val CONTROL_NOTIFICATION = 101
    const val WORKER_NOTIFICATION = 102
    const val VIDEO_NOTIFICATION = 103

    fun preferences(context: Context) = context.getSharedPreferences("paired-browser-v1", Context.MODE_PRIVATE)

    fun channels(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Remote connections", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    fun allowed(context: Context): Boolean {
        val store = HostStore.get(context)
        return store.snapshot.settings.armed &&
            store.snapshot.settings.automatic &&
            store.snapshot.devices.any { store.allowed(it.id, it.generation, automatic = true) } &&
            notificationsAllowed(context)
    }

    fun notificationsAllowed(context: Context): Boolean =
        (
            Build.VERSION.SDK_INT < 33 ||
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) &&
            context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() &&
            context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)?.importance !=
            NotificationManager.IMPORTANCE_NONE

    fun register(context: Context): Boolean {
        if (!allowed(context) || FirebaseApp.getApps(context).isEmpty()) return false
        FirebaseMessaging.getInstance().register().addOnFailureListener {
            preferences(context).save { putString("wakeState", "Wake registration unavailable. Retry in Settings.") }
        }
        enqueue(context, Data.EMPTY, registration = true)
        return true
    }

    fun enqueue(
        context: Context,
        data: Data,
        registration: Boolean = false,
    ) {
        val work =
            OneTimeWorkRequestBuilder<WakeWorker>().setInputData(
                Data
                    .Builder()
                    .putAll(data)
                    .putBoolean("registration", registration)
                    .build(),
            )
        if (!registration && Build.VERSION.SDK_INT >= 31) work.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        if (!registration) work.addTag("remote-session")
        WorkManager.getInstance(context).enqueueUniqueWork(
            if (registration) "register-push" else "remote-wake-${data.getString("pairingId")}",
            // A fresh request can arrive while the previous socket is finishing.
            // Serialize it behind teardown rather than dropping its only hint.
            // Each worker still validates its own request expiry and local policy.
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            work.build(),
        )
    }

    fun notify(
        context: Context,
        text: String,
    ) {
        val pending =
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        context.getSystemService(NotificationManager::class.java).notify(
            NOTIFICATION,
            Notification
                .Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("YepControl")
                .setContentText(text)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setTimeoutAfter(120000)
                .build(),
        )
    }
}

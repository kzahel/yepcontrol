package dev.remoteaccess.app

import android.app.Application
import dev.remoteaccess.app.control.LocalSettingsProtection

class RemoteApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        WakeSupport.channels(this)
        val store = HostStore.get(this)
        store.listeners.add { LocalSettingsProtection.configure(store.snapshot.settings.unrestrictedRemoteControl) }
        HostRuntime.io.execute {
            store.load()
            WakeSupport.register(this)
            WakeSupport.enqueue(this, androidx.work.Data.EMPTY, registration = true)
        }
    }
}

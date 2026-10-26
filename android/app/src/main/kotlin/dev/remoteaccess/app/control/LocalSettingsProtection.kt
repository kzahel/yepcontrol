package dev.remoteaccess.app.control

import android.os.Looper

/** Visible local settings own this gate; every remote transport uses the same input service. */
internal object LocalSettingsProtection {
    private val owners = mutableSetOf<Any>()
    private val hidden = mutableSetOf<Any>()

    @Volatile var hideCapture = false
        private set

    @Volatile var blocked = false
        private set

    @Volatile var revision = 0L
        private set

    fun set(
        owner: Any,
        protected: Boolean,
        hideScreen: Boolean = false,
    ) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val changed = if (protected) owners.add(owner) else owners.remove(owner)
        val captureChanged = if (protected && hideScreen) hidden.add(owner) else hidden.remove(owner)
        if (!changed && !captureChanged) return
        blocked = owners.isNotEmpty()
        hideCapture = hidden.isNotEmpty()
        revision++
        ScreenAccessService.current?.settingsChanged()
    }
}

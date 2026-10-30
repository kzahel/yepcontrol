package dev.remoteaccess.app.control

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/** All transports share this policy. Owners retain their protection while unrestricted mode is on. */
internal object LocalSettingsProtection {
    private val owners = mutableSetOf<Any>()
    private val hidden = mutableSetOf<Any>()
    private val main = Handler(Looper.getMainLooper())
    val listeners = CopyOnWriteArraySet<() -> Unit>()

    @Volatile var unrestricted = false
        private set

    @Volatile var hideCapture = false
        private set

    @Volatile var blocked = false
        private set

    @Volatile var revision = 0L
        private set

    /** Called synchronously on store publication, including background initialization. */
    fun configure(enabled: Boolean) {
        synchronized(this) {
            if (unrestricted == enabled) return
            unrestricted = enabled
            refresh()
        }
        val changed = {
            ScreenAccessService.current?.settingsChanged()
            listeners.forEach { it() }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) changed() else main.post { changed() }
    }

    private fun refresh() {
        blocked = !unrestricted && owners.isNotEmpty()
        hideCapture = !unrestricted && hidden.isNotEmpty()
        revision++
    }

    fun set(
        owner: Any,
        protected: Boolean,
        hideScreen: Boolean = false,
    ) {
        check(Looper.myLooper() == Looper.getMainLooper())
        synchronized(this) {
            val changed = if (protected) owners.add(owner) else owners.remove(owner)
            val captureChanged = if (protected && hideScreen) hidden.add(owner) else hidden.remove(owner)
            if (!changed && !captureChanged) return
            refresh()
        }
        ScreenAccessService.current?.settingsChanged()
    }
}

package com.yepcontrol.mediaspike

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent

/** Compare the system binding used by the real host; no input or screen-reading capabilities. */
class ProbeAccessService : AccessibilityService() {
    override fun onServiceConnected() {
        instance = this
    }

    fun showRequest() {
        startActivity(
            Intent(this, ProbeActivity::class.java)
                .putExtra("arm", true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        var instance: ProbeAccessService? = null
            private set
    }
}

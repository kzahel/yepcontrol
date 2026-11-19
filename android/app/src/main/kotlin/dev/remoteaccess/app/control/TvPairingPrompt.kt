package dev.remoteaccess.app.control

import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.remoteaccess.app.R
import java.util.function.Consumer

/** A local keypad in a separate window so Android Settings keeps its pairing dialog alive. */
class TvPairingPrompt private constructor(
    service: ScreenAccessService,
    private val submit: Consumer<String>,
) : AutoCloseable {
    private val window = service.getSystemService(WindowManager::class.java)
    private val theme = ContextThemeWrapper(service, R.style.Theme_RemoteAccess_Dark)
    private val main = Handler(Looper.getMainLooper())
    private val digits = StringBuilder(6)
    private val timeout = Runnable { close() }
    private var open = false
    private val panel =
        object : LinearLayout(theme) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode != KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)
                if (event.action == KeyEvent.ACTION_UP) close()
                return true
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background =
                GradientDrawable().apply {
                    setColor(0xff121914.toInt())
                    cornerRadius = dp(12).toFloat()
                }
        }
    private val status = TextView(theme).apply { textSize = 17f }
    private val pair =
        button("Pair") {
            val code = digits.toString()
            if (code.length == 6) {
                close()
                submit.accept(code)
            }
        }

    private fun dp(value: Int) = (value * theme.resources.displayMetrics.density).toInt()

    private fun button(
        label: String,
        action: () -> Unit,
    ) = Button(theme).apply {
        text = label
        isAllCaps = false
        isFocusable = true
        setOnClickListener { action() }
    }

    private fun refresh() {
        status.text = theme.getString(R.string.tv_android_code_mask, "•".repeat(digits.length), "–".repeat(6 - digits.length))
        status.contentDescription = theme.getString(R.string.tv_android_code_count, digits.length)
        pair.isEnabled = digits.length == 6
    }

    private fun show() {
        panel.addView(
            TextView(theme).apply {
                setText(R.string.tv_android_code_title)
                textSize = 17f
            },
        )
        panel.addView(status)
        var first: Button? = null
        for (row in listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("Delete", "0", "Pair"))) {
            val keys = LinearLayout(theme)
            for (label in row) {
                val key =
                    when (label) {
                        "Pair" -> pair
                        "Delete" ->
                            button(label) {
                                if (digits.isNotEmpty()) digits.deleteCharAt(digits.lastIndex)
                                refresh()
                            }
                        else ->
                            button(label) {
                                if (digits.length < 6) digits.append(label)
                                refresh()
                            }
                    }
                if (first == null) first = key
                keys.addView(key, LinearLayout.LayoutParams(0, dp(50), 1f))
            }
            panel.addView(keys, LinearLayout.LayoutParams(-1, -2))
        }
        panel.addView(button("Cancel", ::close), LinearLayout.LayoutParams(-1, dp(50)))
        refresh()
        LocalSettingsProtection.set(this, protected = true, requireLocal = true)
        try {
            window.addView(
                panel,
                WindowManager
                    .LayoutParams(
                        dp(236),
                        -2,
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                        PixelFormat.TRANSLUCENT,
                    ).apply {
                        gravity = Gravity.END or Gravity.CENTER_VERTICAL
                        x = dp(24)
                    },
            )
            open = true
            first?.requestFocus()
            main.postDelayed(timeout, 60000)
        } catch (error: RuntimeException) {
            LocalSettingsProtection.set(this, protected = false)
            throw error
        }
    }

    override fun close() {
        if (!open) return
        open = false
        digits.clear()
        main.removeCallbacks(timeout)
        try {
            window.removeViewImmediate(panel)
        } catch (_: IllegalArgumentException) {
            // Android may have removed the accessibility window when the service disconnected.
        } finally {
            LocalSettingsProtection.set(this, protected = false)
        }
    }

    companion object {
        @JvmStatic
        fun show(submit: Consumer<String>): TvPairingPrompt? {
            val service = ScreenAccessService.current ?: return null
            return runCatching { TvPairingPrompt(service, submit).also { it.show() } }.getOrNull()
        }

        @JvmStatic
        fun available() = ScreenAccessService.current != null
    }
}

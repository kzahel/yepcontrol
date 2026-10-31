package com.yepcontrol.mediaspike

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Separate UID; the optional system-binding comparison never alters the installed host. */
class ProbeActivity : Activity() {
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        connect()
    }

    override fun onResume() {
        super.onResume()
        if (intent.getBooleanExtra("arm", false)) {
            intent.removeExtra("arm")
            Probe.command("arm")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 48, 32, 32)
            }
        layout.addView(
            TextView(this).apply {
                text =
                    "YepControl media experiment\n\nThis test briefly streams the camera and microphone to this computer. No recording is saved. Stop ends sensor access. The experiment ends automatically after two minutes."
                textSize = 20f
            },
        )
        layout.addView(
            Button(this).apply {
                text = "Grant camera and microphone"
                setOnClickListener {
                    requestPermissions(
                        listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
                            .plus(if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList())
                            .toTypedArray(),
                        1,
                    )
                }
            },
        )
        layout.addView(
            Button(this).apply {
                text = "Enable two-minute test session"
                setOnClickListener { Probe.command("arm") }
            },
        )
        layout.addView(
            Button(this).apply {
                text = "Stop"
                setOnClickListener { Probe.end() }
            },
        )
        setContentView(layout)
        connect()
    }

    private fun connect() {
        val port = intent.getIntExtra("port", 0)
        val token = intent.getStringExtra("token").orEmpty()
        if (port in 1024..65535 && token.matches(Regex("[0-9a-f]{64}"))) Probe.connect(applicationContext, port, token)
    }
}

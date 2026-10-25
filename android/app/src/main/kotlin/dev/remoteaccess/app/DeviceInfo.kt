package dev.remoteaccess.app

import android.content.Context
import android.os.Build
import android.provider.Settings
import org.json.JSONObject

/** What this phone tells paired viewers about itself; read fresh for every report so updates show. */
internal object DeviceInfo {
    private fun clean(
        value: String?,
        max: Int,
        fallback: String,
    ) = value
        ?.filterNot { it.isISOControl() }
        ?.trim()
        ?.take(max)
        ?.trim()
        ?.ifEmpty { null } ?: fallback

    fun report(context: Context): JSONObject {
        val model = clean(Build.MODEL, 80, "Android phone")
        return JSONObject()
            .put("manufacturer", clean(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, 80, "Unknown"))
            .put("model", model)
            .put("name", clean(Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME), 80, model))
            .put("android", clean(Build.VERSION.RELEASE, 20, Build.VERSION.SDK_INT.toString()))
            .put("sdk", Build.VERSION.SDK_INT)
            .put("app", clean(BuildConfig.VERSION_NAME, 40, "unknown"))
            .put("connectionPreparation", 1)
    }
}

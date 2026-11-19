package dev.remoteaccess.app

import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration

internal fun Context.isTv() =
    packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
        getSystemService(UiModeManager::class.java).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION

internal fun PackageManager.launcherActivities(tv: Boolean) =
    listOf(Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER)
        .let { if (tv) it else it.reversed() }
        .flatMap { category -> queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(category), 0) }
        .distinctBy { it.activityInfo.packageName }

internal fun PackageManager.launchIntent(
    packageName: String,
    tv: Boolean,
): Intent? =
    if (tv) {
        getLeanbackLaunchIntentForPackage(packageName) ?: getLaunchIntentForPackage(packageName)
    } else {
        getLaunchIntentForPackage(packageName) ?: getLeanbackLaunchIntentForPackage(packageName)
    }

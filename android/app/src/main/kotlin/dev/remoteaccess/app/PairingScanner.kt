package dev.remoteaccess.app

import android.app.Activity
import android.os.SystemClock
import androidx.lifecycle.ViewModel
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** Retains a single scanner request across recreation, without persisting scanned secrets. */
internal class PairingScanner : ViewModel() {
    class Request(
        val page: String,
    ) {
        val started = SystemClock.elapsedRealtime()
        var task: Task<String>? = null
        var ignored = false
    }

    var pending: Request? = null
        private set

    internal var open: (Activity) -> Task<String> = { activity ->
        val options =
            GmsBarcodeScannerOptions
                .Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build()
        GmsBarcodeScanning.getClient(activity, options).startScan().onSuccessTask { Tasks.forResult(it.rawValue.orEmpty()) }
    }

    fun begin(page: String): Request? {
        if (pending != null) return null
        return Request(page).also { pending = it }
    }

    fun ignore() {
        pending?.ignored = true
    }

    fun take(request: Request): Boolean {
        if (pending !== request) return false
        pending = null
        return true
    }
}

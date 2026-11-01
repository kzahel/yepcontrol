package com.yepcontrol.adbspike;
import android.app.RemoteInput;
import android.content.*;
import android.os.Bundle;
public final class PairReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent intent) {
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        if (results == null || !Store.enabled(c)) return;
        CharSequence code = results.getCharSequence("code");
        if (code == null || !code.toString().matches("[0-9]{6}")) return;
        c.startForegroundService(new Intent(c, AdvancedService.class).putExtra("code", code.toString()));
    }
}

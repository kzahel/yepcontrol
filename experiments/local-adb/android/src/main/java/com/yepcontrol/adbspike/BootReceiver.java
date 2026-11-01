package com.yepcontrol.adbspike;
import android.content.*;
public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent intent) {
        if (Store.enabled(c)) {
            Store.record(c, "boot-recovery-start", "");
            c.startForegroundService(new Intent(c, AdvancedService.class));
        }
    }
}

package com.yepcontrol.adbspike;
import android.app.Activity;
import android.os.*;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;
public final class ProtectedActivity extends Activity {
    Button target;
    void receipt() {
        try {
            int[] xy = new int[2]; target.getLocationOnScreen(xy);
            Store.receipt(this, "fixture", new JSONObject().put("count", Store.prefs(this).getInt("count", 0))
                .put("x", xy[0] + target.getWidth()/2).put("y", xy[1] + target.getHeight()/2));
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        FrameLayout root = new FrameLayout(this);
        if (Build.VERSION.SDK_INT >= 34) root.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES);
        target = new Button(this); target.setId(R.id.protected_tap); target.setText("Protected button — count " + Store.prefs(this).getInt("count", 0));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(650, 200, Gravity.CENTER); root.addView(target, lp); setContentView(root);
        target.setOnClickListener(v -> {
            int count = Store.prefs(this).getInt("count", 0) + 1;
            Store.prefs(this).edit().putInt("count", count).commit(); target.setText("Protected button — count " + count); receipt();
        });
        target.post(this::receipt);
    }
}

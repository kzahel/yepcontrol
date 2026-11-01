package dev.remoteaccess.app.advanced;

import android.app.Activity;
import android.os.*;
import android.view.View;
import android.widget.*;

@android.annotation.SuppressLint("SetTextI18n")
public final class ProtectedFixture extends Activity {
  public static volatile int count, x, y;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    if (Build.VERSION.SDK_INT >= 34)
      root.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES);
    Button button = new Button(this);
    button.setText("Protected count " + count);
    button.setOnClickListener(
        v -> {
          count++;
          button.setText("Protected count " + count);
        });
    root.addView(button, new LinearLayout.LayoutParams(-1, 300));
    setContentView(root);
    button.post(
        () -> {
          int[] location = new int[2];
          button.getLocationOnScreen(location);
          x = location[0] + button.getWidth() / 2;
          y = location[1] + button.getHeight() / 2;
        });
  }
}

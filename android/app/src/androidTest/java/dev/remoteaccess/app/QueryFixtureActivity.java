package dev.remoteaccess.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public final class QueryFixtureActivity extends Activity {
    private int taps;
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        int height = Math.max(14, getResources().getDisplayMetrics().heightPixels / 25);
        for (int row = 0; row < 18; row++) {
            LinearLayout line = new LinearLayout(this);
            for (int column = 0; column < 10; column++) {
                int index = row * 10 + column;
                TextView label = new TextView(this);
                label.setText(index == 0 || index == 80 || index == 179 ? "Repeated marker" : "Item " + index);
                label.setTextSize(8);
                label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
                line.addView(label, new LinearLayout.LayoutParams(0, height, 1));
            }
            root.addView(line);
        }
        Button target = new Button(this);
        target.setText("Beyond prefix");
        target.setAllCaps(false);
        target.setOnClickListener(view -> {
            taps++;
            target.setText("Query taps: " + taps);
            try (FileOutputStream output = new FileOutputStream(new File(getFilesDir(), "query-taps"))) {
                output.write(Integer.toString(taps).getBytes(StandardCharsets.UTF_8));
            } catch (Exception failure) { throw new IllegalStateException(failure); }
        });
        root.addView(target);
        LinearLayout protectedContainer = new LinearLayout(this);
        protectedContainer.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        protectedContainer.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setPassword(true);
            }
        });
        TextView secret = new TextView(this);
        secret.setText("Private descendant");
        protectedContainer.addView(secret);
        root.addView(protectedContainer);
        setContentView(root);
    }
}

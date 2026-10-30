package dev.remoteaccess.app;

import android.app.Activity;
import android.content.Intent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityEvent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.MotionEvent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Independent Android effects witness, only in the instrumentation APK.
 * Java keeps this separately launched APK independent of the target's Kotlin runtime.
 */
public final class ControlFixtureActivity extends Activity {
    private int taps, longPresses, sliderProgress;
    private String entered = "";
    private boolean sliderHeld;
    private boolean keyboardShown;
    private Button target;
    private EditText field;
    private EditText password;
    private LinearLayout content;
    private ScrollView scroll;
    private SeekBar slider;
    private View multi;
    private int maxPointers, multiMoves;
    private double firstDistance, lastDistance, firstAngle, lastAngle;

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        scroll.post(this::witness);
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        content = new LinearLayout(this);
        content.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(40, 100, 40, 40);
        content.setBackgroundColor(Color.rgb(225, 242, 255));
        TextView title = new TextView(this);
        title.setText("Remote control fixture");
        title.setTextSize(24);
        content.addView(title);
        target = new Button(this);
        target.setText("Tap witness");
        target.setAllCaps(false);
        target.setOnClickListener(v -> { taps++; target.setText("Tapped " + taps); witness(); });
        target.setOnLongClickListener(v -> { longPresses++; witness(); return true; });
        field = new EditText(this);
        field.setHint("Type witness");
        field.setSingleLine(true);
        field.setOnFocusChangeListener((view, focused) -> witness());
        field.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { entered = s.toString(); witness(); }
            @Override public void afterTextChanged(Editable value) {}
        });
        slider = new SeekBar(this);
        slider.setMax(1000);
        slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean user) { if (user) { sliderProgress = progress; witness(); } }
            @Override public void onStartTrackingTouch(SeekBar bar) { sliderHeld = true; witness(); }
            @Override public void onStopTrackingTouch(SeekBar bar) { sliderHeld = false; witness(); }
        });
        content.addView(target, new LinearLayout.LayoutParams(-1, 160));
        content.addView(field, new LinearLayout.LayoutParams(-1, 160));
        content.addView(slider, new LinearLayout.LayoutParams(-1, 160));
        password = new EditText(this);
        password.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setText("fixture-private-password");
        password.setContentDescription("fixture-private-password");
        content.addView(password, new LinearLayout.LayoutParams(-1, 110));
        multi = new View(this) {
            final Paint paint = new Paint();
            @Override protected void onDraw(Canvas canvas) {
                paint.setColor(Color.BLUE);
                float x = 80 + (android.os.SystemClock.uptimeMillis() % 1800) / 1800f * (getWidth() - 160);
                canvas.drawCircle(x, getHeight() / 2f, 50, paint);
                postInvalidateOnAnimation();
            }
            @Override public boolean onTouchEvent(MotionEvent event) {
                getParent().requestDisallowInterceptTouchEvent(true);
                maxPointers = Math.max(maxPointers, event.getPointerCount());
                if (event.getPointerCount() == 2) {
                    double dx = event.getX(1) - event.getX(0), dy = event.getY(1) - event.getY(0);
                    lastDistance = Math.hypot(dx, dy); lastAngle = Math.atan2(dy, dx);
                    if (event.getActionMasked() == MotionEvent.ACTION_POINTER_DOWN) {
                        firstDistance = lastDistance; firstAngle = lastAngle;
                    } else if (event.getActionMasked() == MotionEvent.ACTION_MOVE) multiMoves++;
                }
                witness();
                return true;
            }
        };
        content.addView(multi, new LinearLayout.LayoutParams(-1, 500));
        for (int i = 0; i < 40; i++) {
            TextView item = new TextView(this);
            item.setText("Scroll item " + i);
            item.setTextSize(22);
            item.setPadding(0, 30, 0, 30);
            content.addView(item);
        }
        scroll = new ScrollView(this);
        scroll.addView(content);
        scroll.setOnScrollChangeListener((v, x, y, oldX, oldY) -> witness());
        scroll.getViewTreeObserver().addOnGlobalLayoutListener(this::witness);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            keyboardShown = insets.isVisible(WindowInsets.Type.ime());
            scroll.post(this::witness);
            return insets;
        });
        setContentView(scroll);
        scroll.post(this::witness);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String mode = intent.getStringExtra("fixtureMutation");
        if ("label".equals(mode)) target.setText("Changed witness");
        if ("long-old".equals(mode) || "long-new".equals(mode)) {
            field.setText(new String(new char[256]).replace('\0', 'a') + ("long-old".equals(mode) ? "old" : "new"));
        }
        if ("password-container".equals(mode)) {
            content.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                @Override public void onInitializeAccessibilityNodeInfo(View view, AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(view, info);
                    info.setPassword(true);
                }
            });
        }
        content.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
        witness();
    }

    private JSONObject center(View view) throws Exception {
        int[] location = new int[2];
        view.getLocationOnScreen(location);
        return new JSONObject().put("x", location[0] + view.getWidth() / 2).put("y", location[1] + view.getHeight() / 2);
    }

    private void witness() {
        if (scroll == null) return;
        try {
            JSONObject value = new JSONObject().put("taps", taps).put("text", entered).put("password", password.getText().toString()).put("scroll", scroll.getScrollY())
                .put("keyboardShown", keyboardShown)
                .put("fieldFocused", field.hasFocus())
                .put("target", center(target)).put("field", center(field)).put("slider", center(slider))
                .put("sliderProgress", sliderProgress).put("longPresses", longPresses).put("sliderHeld", sliderHeld)
                .put("multi", center(multi)).put("maxPointers", maxPointers).put("multiMoves", multiMoves)
                .put("distanceChange", lastDistance - firstDistance).put("angleChange", lastAngle - firstAngle);
            File next = new File(getFilesDir(), "control-witness.next");
            try (FileOutputStream output = new FileOutputStream(next)) { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); }
            if (!next.renameTo(new File(getFilesDir(), "control-witness.json"))) throw new IllegalStateException("Witness replacement failed");
        } catch (Exception error) { throw new IllegalStateException("Witness write failed", error); }
    }
}

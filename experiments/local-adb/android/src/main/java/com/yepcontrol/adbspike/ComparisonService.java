package com.yepcontrol.adbspike;
import android.accessibilityservice.*;
import android.graphics.Path;
import android.view.accessibility.AccessibilityEvent;
import android.os.Handler;
public final class ComparisonService extends AccessibilityService {
    static volatile ComparisonService instance;
    @Override protected void onServiceConnected() { instance = this; }
    @Override public void onDestroy() { instance = null; super.onDestroy(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {}
    @Override public void onInterrupt() {}
    void tap(int x, int y, java.util.function.Consumer<String> result) {
        Path path = new Path(); path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path, 0, 60)).build();
        boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { result.accept("completed"); }
            @Override public void onCancelled(GestureDescription g) { result.accept("cancelled"); }
        }, new Handler(getMainLooper()));
        if (!accepted) result.accept("not-accepted");
    }
}

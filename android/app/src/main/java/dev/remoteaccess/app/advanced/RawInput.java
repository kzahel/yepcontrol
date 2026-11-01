// SPDX-License-Identifier: MIT
package dev.remoteaccess.app.advanced;

import android.os.SystemClock;
import android.view.*;
import java.io.IOException;
import java.lang.reflect.Method;
import java.util.*;
import org.json.*;

/** Bounded touch packets. Held contacts are cancelled after 700 ms without a valid packet. */
@android.annotation.SuppressLint("PrivateApi") // Executed only by the OS-authenticated shell UID.
final class RawInput {
  private final LinkedHashMap<Integer, float[]> fingers = new LinkedHashMap<>();
  private final Map<Integer, Integer> slots = new HashMap<>();
  private String owner = "";
  private int sequence = -1, gesture, scene;
  private long down, last, started;
  private final Object manager;
  private final Method inject;

  RawInput() throws Exception {
    Class<?> type;
    try {
      type = Class.forName("android.hardware.input.InputManagerGlobal");
    } catch (ClassNotFoundException e) {
      type = Class.forName("android.hardware.input.InputManager");
    }
    manager = type.getMethod("getInstance").invoke(null);
    inject = type.getMethod("injectInputEvent", InputEvent.class, int.class);
  }

  void idle() throws Exception {
    long now = SystemClock.uptimeMillis();
    if (!fingers.isEmpty() && (now - last > 700 || now - started > 60000)) cancel();
  }

  void cancel() throws Exception {
    try {
      if (!fingers.isEmpty()) event(MotionEvent.ACTION_CANCEL);
    } finally {
      fingers.clear();
      slots.clear();
      owner = "";
      sequence = -1;
    }
  }

  void accept(JSONObject request) throws Exception {
    idle();
    String who = request.getString("owner");
    int seq = request.getInt("sequence");
    int duration = request.getInt("duration"),
        nextGesture = request.getInt("gesture"),
        nextScene = request.getInt("scene");
    JSONArray contacts = request.getJSONArray("contacts");
    if (who.length() > 128
        || who.isEmpty()
        || duration < 16
        || duration > 100
        || contacts.length() < 1
        || contacts.length() > 10) throw new IllegalArgumentException();
    if ((!fingers.isEmpty()
            && (!owner.equals(who)
                || seq != sequence + 1
                || gesture != nextGesture
                || scene != nextScene))
        || (fingers.isEmpty() && seq != 0)) {
      cancel();
      throw new IllegalArgumentException("Stale touch packet");
    }
    LinkedHashMap<Integer, JSONObject> input = new LinkedHashMap<>();
    for (int i = 0; i < contacts.length(); i++) {
      JSONObject contact = contacts.getJSONObject(i);
      int id = contact.getInt("id");
      JSONArray path = contact.getJSONArray("path");
      if (id < 0
          || id > 1000000
          || input.put(id, contact) != null
          || path.length() < 1
          || path.length() > 24) throw new IllegalArgumentException();
      for (int j = 0; j < path.length(); j++) {
        JSONArray point = path.getJSONArray(j);
        if (point.length() != 2
            || point.getDouble(0) < 0
            || point.getDouble(0) > 20000
            || point.getDouble(1) < 0
            || point.getDouble(1) > 20000) throw new IllegalArgumentException();
      }
    }
    if (!input.keySet().containsAll(fingers.keySet())) {
      cancel();
      throw new IllegalArgumentException();
    }
    try {
      long began = SystemClock.uptimeMillis();
      if (fingers.isEmpty()) {
        down = began;
        started = began;
      }
      owner = who;
      sequence = seq;
      gesture = nextGesture;
      scene = nextScene;
      for (Map.Entry<Integer, JSONObject> entry : input.entrySet()) {
        if (fingers.containsKey(entry.getKey())) continue;
        JSONArray p = entry.getValue().getJSONArray("path").getJSONArray(0);
        int slot = 0;
        while (slots.containsValue(slot)) slot++;
        if (slot >= 10) throw new IllegalArgumentException();
        slots.put(entry.getKey(), slot);
        fingers.put(entry.getKey(), new float[] {(float) p.getDouble(0), (float) p.getDouble(1)});
        event(
            fingers.size() == 1
                ? MotionEvent.ACTION_DOWN
                : MotionEvent.ACTION_POINTER_DOWN
                    | ((fingers.size() - 1) << MotionEvent.ACTION_POINTER_INDEX_SHIFT));
      }
      for (int elapsed = 16; ; elapsed += 16) {
        int at = Math.min(elapsed, duration);
        Thread.sleep(Math.max(0, began + at - SystemClock.uptimeMillis()));
        for (Map.Entry<Integer, JSONObject> entry : input.entrySet()) {
          JSONArray path = entry.getValue().getJSONArray("path");
          float position = ((float) at / duration) * (path.length() - 1);
          int lo = (int) position, hi = Math.min(lo + 1, path.length() - 1);
          float f = position - lo;
          JSONArray a = path.getJSONArray(lo), b = path.getJSONArray(hi);
          fingers.put(
              entry.getKey(),
              new float[] {
                (float) (a.getDouble(0) + (b.getDouble(0) - a.getDouble(0)) * f),
                (float) (a.getDouble(1) + (b.getDouble(1) - a.getDouble(1)) * f)
              });
        }
        event(MotionEvent.ACTION_MOVE);
        if (at == duration) break;
      }
      for (Map.Entry<Integer, JSONObject> entry : input.entrySet()) {
        if (entry.getValue().getBoolean("held")) continue;
        int index = new ArrayList<>(fingers.keySet()).indexOf(entry.getKey());
        event(
            fingers.size() == 1
                ? MotionEvent.ACTION_UP
                : MotionEvent.ACTION_POINTER_UP
                    | (index << MotionEvent.ACTION_POINTER_INDEX_SHIFT));
        fingers.remove(entry.getKey());
        slots.remove(entry.getKey());
      }
      last = SystemClock.uptimeMillis();
      if (fingers.isEmpty()) {
        owner = "";
        sequence = -1;
      }
    } catch (Exception failure) {
      cancel();
      throw failure;
    }
  }

  private void event(int action) throws Exception {
    MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[fingers.size()];
    MotionEvent.PointerCoords[] coordinates = new MotionEvent.PointerCoords[fingers.size()];
    int i = 0;
    for (Map.Entry<Integer, float[]> finger : fingers.entrySet()) {
      MotionEvent.PointerProperties p = new MotionEvent.PointerProperties();
      p.id = slots.get(finger.getKey());
      p.toolType = MotionEvent.TOOL_TYPE_FINGER;
      properties[i] = p;
      MotionEvent.PointerCoords c = new MotionEvent.PointerCoords();
      c.x = finger.getValue()[0];
      c.y = finger.getValue()[1];
      c.pressure = 1;
      c.size = 1;
      coordinates[i++] = c;
    }
    MotionEvent event =
        MotionEvent.obtain(
            down,
            SystemClock.uptimeMillis(),
            action,
            fingers.size(),
            properties,
            coordinates,
            0,
            0,
            1,
            1,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0);
    try {
      if (!Boolean.TRUE.equals(inject.invoke(manager, event, 2)))
        throw new IOException("Input injection rejected");
    } finally {
      event.recycle();
    }
  }
}

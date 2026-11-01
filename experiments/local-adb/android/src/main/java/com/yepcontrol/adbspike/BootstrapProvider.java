package com.yepcontrol.adbspike;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Bind the current bootstrap secret to an OS-authenticated shell process. */
public final class BootstrapProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    @Override public Bundle call(String method, String argument, Bundle data) {
        if (Binder.getCallingUid() != 2000 || !"attest".equals(method) || data == null || !Store.enabled(getContext())) throw new SecurityException("Shell bootstrap required");
        String actual = data.getString("token", ""), expected = Store.prefs(getContext()).getString("token", "");
        if (expected.isEmpty() || !MessageDigest.isEqual(actual.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8))
            || data.getInt("port") != Store.prefs(getContext()).getInt("port", 0)) throw new SecurityException("Bootstrap mismatch");
        Store.prefs(getContext()).edit().putInt("attestedPid", Binder.getCallingPid()).putInt("attestedUid", Binder.getCallingUid()).commit();
        Bundle reply = new Bundle(); reply.putBoolean("accepted", true); return reply;
    }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { throw new SecurityException(); }
    @Override public String getType(Uri u) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { throw new SecurityException(); }
    @Override public int delete(Uri u, String s, String[] a) { throw new SecurityException(); }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { throw new SecurityException(); }
}

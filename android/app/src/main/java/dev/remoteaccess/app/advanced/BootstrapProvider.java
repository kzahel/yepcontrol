package dev.remoteaccess.app.advanced;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Bind the current bootstrap secret to an OS-authenticated shell process. */
public final class BootstrapProvider extends ContentProvider {
  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public Bundle call(String method, String argument, Bundle data) {
    if (Binder.getCallingUid() != 2000
        || !"attest".equals(method)
        || data == null
        || !Store.enabled(getContext())) throw new SecurityException("Shell bootstrap required");
    Store.Capability capability = Store.capability;
    if (capability == null) throw new SecurityException("No pending bootstrap");
    String actual = data.getString("token", ""), expected = capability.token;
    if (expected.isEmpty()
        || !MessageDigest.isEqual(
            actual.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8))
        || data.getInt("port") != capability.port)
      throw new SecurityException("Bootstrap mismatch");
    capability.pid = Binder.getCallingPid();
    capability.uid = Binder.getCallingUid();
    Bundle reply = new Bundle();
    reply.putBoolean("accepted", true);
    return reply;
  }

  @Override
  public Cursor query(Uri u, String[] p, String s, String[] a, String o) {
    throw new SecurityException();
  }

  @Override
  public String getType(Uri u) {
    return null;
  }

  @Override
  public Uri insert(Uri u, ContentValues v) {
    throw new SecurityException();
  }

  @Override
  public int delete(Uri u, String s, String[] a) {
    throw new SecurityException();
  }

  @Override
  public int update(Uri u, ContentValues v, String s, String[] a) {
    throw new SecurityException();
  }
}

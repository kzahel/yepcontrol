// SPDX-License-Identifier: MIT
package io.github.muntashirakon.crypto.spake2;

/** Independent JNI adapter to upstream BoringSSL. No spake2-java implementation is bundled. */
public final class Spake2Context {
  static {
    System.loadLibrary("yep_pairing");
  }

  private long handle;
  private boolean generated;
  private boolean processed;

  public Spake2Context(Spake2Role role, byte[] ownName, byte[] peerName) {
    if (ownName == null || peerName == null || ownName.length > 1024 || peerName.length > 1024) throw new IllegalArgumentException();
    handle = create(role == Spake2Role.Alice, ownName, peerName);
    if (handle == 0) throw new IllegalStateException("SPAKE2 allocation failed");
  }

  public synchronized byte[] generateMessage(byte[] password) {
    if (password == null || password.length > 1024) throw new IllegalArgumentException();
    if (handle == 0 || generated) throw new IllegalStateException();
    generated = true;
    byte[] value = generate(handle, password);
    if (value == null) {
      destroy();
      throw new IllegalStateException("SPAKE2 message failed");
    }
    return value;
  }

  public synchronized byte[] processMessage(byte[] message) {
    if (message == null || message.length > 64) throw new IllegalArgumentException();
    if (handle == 0 || !generated || processed) throw new IllegalStateException();
    processed = true;
    return process(handle, message);
  }

  public synchronized void destroy() {
    if (handle != 0) {
      free(handle);
      handle = 0;
    }
  }

  private static native long create(boolean alice, byte[] ownName, byte[] peerName);

  private static native byte[] generate(long handle, byte[] password);

  private static native byte[] process(long handle, byte[] message);

  private static native void free(long handle);
}

// SPDX-License-Identifier: MIT
package dev.remoteaccess.app.advanced;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

/** Credential-encrypted, backup-excluded identity, wrapped by an Android Keystore key. */
final class Vault {
  private static final String ALIAS = "advanced-adb-identity-v1";

  private static SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
    KeyGenerator generator =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(
        new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(false)
            .build());
    return generator.generateKey();
  }

  static byte[] read(Context c, File file) throws Exception {
    byte[] saved = new AtomicFile(file).readFully();
    if (saved.length < 29 || saved.length > 32768) throw new IOException("Invalid identity");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOf(saved, 12)));
    return cipher.doFinal(saved, 12, saved.length - 12);
  }

  static void write(Context c, File file, byte[] plain) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    AtomicFile atomic = new AtomicFile(file);
    FileOutputStream out = atomic.startWrite();
    try {
      out.write(cipher.getIV());
      out.write(cipher.doFinal(plain));
      atomic.finishWrite(out);
    } catch (Exception e) {
      atomic.failWrite(out);
      throw e;
    } finally {
      Arrays.fill(plain, (byte) 0);
    }
  }

  static void forget(Context c) throws Exception {
    new AtomicFile(new File(c.getNoBackupFilesDir(), "advanced-identity")).delete();
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
    keys.load(null);
    keys.deleteEntry(ALIAS);
  }
}

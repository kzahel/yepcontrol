// SPDX-License-Identifier: Apache-2.0
// Key/trust-manager integration adapted from libadb-android 3.1.1 SslUtils,
// under its elected Apache-2.0 license. No process-wide TLS provider is changed.
package dev.remoteaccess.app.advanced;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.net.Socket;
import java.security.*;
import java.security.cert.X509Certificate;
import javax.net.ssl.*;

/** Bind libadb's singleton to each connection owner, including fresh session caches. */
final class AdbTls {
  private AdbTls() {}

  // Called only with Store's monitor held after the exact Start-generation check.
  static void bind(PrivateKey key, X509Certificate certificate) throws Exception {
    X509ExtendedKeyManager manager =
        new X509ExtendedKeyManager() {
          private final String alias = "advanced";

          public String[] getClientAliases(String type, Principal[] issuers) {
            return "RSA".equals(type) ? new String[] {alias} : null;
          }

          public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) {
            for (String type : types) if ("RSA".equals(type)) return alias;
            return null;
          }

          public String chooseEngineClientAlias(
              String[] types, Principal[] issuers, SSLEngine engine) {
            return chooseClientAlias(types, issuers, null);
          }

          public String[] getServerAliases(String type, Principal[] issuers) {
            return null;
          }

          public String chooseServerAlias(String type, Principal[] issuers, Socket socket) {
            return null;
          }

          public X509Certificate[] getCertificateChain(String value) {
            return alias.equals(value) ? new X509Certificate[] {certificate} : null;
          }

          public PrivateKey getPrivateKey(String value) {
            return alias.equals(value) ? key : null;
          }
        };
    replace(new KeyManager[] {manager});
  }

  static void forget() throws Exception {
    // An empty key-manager array is deliberate: null would select default credentials.
    // A fresh context also drops the forgotten identity's TLS resumption tickets.
    replace(new KeyManager[0]);
  }

  @android.annotation.SuppressLint({"TrustAllX509TrustManager", "CustomX509TrustManager"})
  private static void replace(KeyManager[] managers) throws Exception {
    SSLContext fresh = SSLContext.getInstance("TLSv1.3", org.conscrypt.Conscrypt.newProvider());
    // ADB's self-signed certificates are not Web PKI. This context is used only
    // by phone-local paired ADB; shell-UID attestation still gates readiness.
    X509TrustManager trust =
        new X509TrustManager() {
          public void checkClientTrusted(X509Certificate[] chain, String authType) {}

          public void checkServerTrusted(X509Certificate[] chain, String authType) {}

          public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
          }
        };
    fresh.init(managers, new TrustManager[] {trust}, new SecureRandom());

    // This is reflection over two fields in the exact pinned third-party
    // component, not an Android hidden API. Publish a fully initialized context
    // atomically, never null: stale library workers must not recreate an old one.
    Class<?> type = Class.forName("io.github.muntashirakon.adb.SslUtils");
    Field cache = type.getDeclaredField("sslContext");
    Field custom = type.getDeclaredField("customConscrypt");
    if (cache.getType() != SSLContext.class
        || !Modifier.isStatic(cache.getModifiers())
        || custom.getType() != boolean.class
        || !Modifier.isStatic(custom.getModifiers()))
      throw new GeneralSecurityException("Unsupported pinned ADB TLS adapter");
    cache.setAccessible(true);
    custom.setAccessible(true);
    custom.setBoolean(null, true);
    cache.set(null, fresh);
  }
}

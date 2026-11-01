package com.yepcontrol.adbspike;

import android.util.Base64;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Framed, mutually authenticated loopback requests; fresh challenges prevent replay. */
final class Wire {
    static String random() { byte[] v = new byte[32]; new SecureRandom().nextBytes(v); return Base64.encodeToString(v, Base64.NO_WRAP); }
    static String mac(String key, String value) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(Base64.decode(key, Base64.DEFAULT), "HmacSHA256"));
        return Base64.encodeToString(m.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    }
    static void verify(String actual, String expected) throws Exception {
        if (!MessageDigest.isEqual(actual.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8))) throw new SecurityException("Helper authentication failed");
    }
    static String read(DataInputStream in) throws Exception {
        int n = in.readInt(); if (n < 0 || n > 65536) throw new IOException("Invalid frame");
        byte[] b = new byte[n]; in.readFully(b); return new String(b, StandardCharsets.UTF_8);
    }
    static void write(DataOutputStream out, String s) throws Exception {
        byte[] b = s.getBytes(StandardCharsets.UTF_8); out.writeInt(b.length); out.write(b); out.flush();
    }
}

package com.yepcontrol.adbspike;

import android.content.Context;
import android.util.AtomicFile;
import android.util.Base64;
import io.github.muntashirakon.adb.AbsAdbConnectionManager;
import java.io.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.*;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Date;
import org.bouncycastle.asn1.*;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.*;
import org.json.JSONObject;

final class Identity extends AbsAdbConnectionManager {
    private final PrivateKey key;
    private final Certificate cert;
    Identity(Context context) throws Exception {
        setApi(android.os.Build.VERSION.SDK_INT);
        File file = new File(context.getNoBackupFilesDir(), "identity.json");
        JSONObject saved;
        if (file.exists()) saved = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        else {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048);
            java.security.KeyPair pair = generator.generateKeyPair();
            AlgorithmIdentifier alg = new AlgorithmIdentifier(PKCSObjectIdentifiers.sha256WithRSAEncryption, DERNull.INSTANCE);
            V3TBSCertificateGenerator gen = new V3TBSCertificateGenerator();
            gen.setSerialNumber(new ASN1Integer(new BigInteger(120, new SecureRandom())));
            X500Name name = new X500Name("CN=YepControl local ADB spike");
            gen.setIssuer(name); gen.setSubject(name); gen.setSignature(alg);
            gen.setStartDate(new Time(new Date(System.currentTimeMillis() - 86400000L)));
            gen.setEndDate(new Time(new Date(System.currentTimeMillis() + 315360000000L)));
            gen.setSubjectPublicKeyInfo(SubjectPublicKeyInfo.getInstance(pair.getPublic().getEncoded()));
            TBSCertificate tbs = gen.generateTBSCertificate();
            Signature sig = Signature.getInstance("SHA256withRSA"); sig.initSign(pair.getPrivate()); sig.update(tbs.getEncoded());
            byte[] der = new DERSequence(new ASN1Encodable[]{tbs, alg, new DERBitString(sig.sign())}).getEncoded();
            saved = new JSONObject().put("key", Base64.encodeToString(pair.getPrivate().getEncoded(), Base64.NO_WRAP))
                .put("certificate", Base64.encodeToString(der, Base64.NO_WRAP));
            AtomicFile atomic = new AtomicFile(file); FileOutputStream out = atomic.startWrite();
            try { out.write(saved.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(out); }
            catch (Exception e) { atomic.failWrite(out); throw e; }
        }
        key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.decode(saved.getString("key"), Base64.DEFAULT)));
        cert = CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(Base64.decode(saved.getString("certificate"), Base64.DEFAULT)));
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(cert.getPublicKey().getEncoded())) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        String fingerprint = hex.toString();
        Store.prefs(context).edit().putString("identity", fingerprint).apply();
    }
    @Override protected PrivateKey getPrivateKey() { return key; }
    @Override protected Certificate getCertificate() { return cert; }
    @Override protected String getDeviceName() { return "YepControl-local-spike"; }
}

// SPDX-License-Identifier: MIT
// Only a bounded JNI adapter. SPAKE2 itself is upstream BoringSSL.
#include <jni.h>
#include <openssl/curve25519.h>
#include <openssl/mem.h>
#include <vector>

static std::vector<uint8_t> bytes(JNIEnv* env, jbyteArray array) {
    std::vector<uint8_t> value(static_cast<size_t>(env->GetArrayLength(array)));
    env->GetByteArrayRegion(array, 0, static_cast<jsize>(value.size()), reinterpret_cast<jbyte*>(value.data()));
    return value;
}
static jbyteArray result(JNIEnv* env, const uint8_t* data, size_t size) {
    auto array = env->NewByteArray(static_cast<jsize>(size));
    if (array) env->SetByteArrayRegion(array, 0, static_cast<jsize>(size), reinterpret_cast<const jbyte*>(data));
    return array;
}
extern "C" JNIEXPORT jlong JNICALL
Java_io_github_muntashirakon_crypto_spake2_Spake2Context_create(JNIEnv* env, jclass, jboolean alice, jbyteArray own, jbyteArray peer) {
    auto a = bytes(env, own); auto b = bytes(env, peer);
    return reinterpret_cast<jlong>(SPAKE2_CTX_new(alice ? spake2_role_alice : spake2_role_bob, a.data(), a.size(), b.data(), b.size()));
}
extern "C" JNIEXPORT jbyteArray JNICALL
Java_io_github_muntashirakon_crypto_spake2_Spake2Context_generate(JNIEnv* env, jclass, jlong handle, jbyteArray password) {
    auto secret = bytes(env, password); uint8_t message[SPAKE2_MAX_MSG_SIZE]; size_t size = 0;
    int ok = SPAKE2_generate_msg(reinterpret_cast<SPAKE2_CTX*>(handle), message, &size, sizeof(message), secret.data(), secret.size());
    OPENSSL_cleanse(secret.data(), secret.size());
    return ok == 1 ? result(env, message, size) : nullptr;
}
extern "C" JNIEXPORT jbyteArray JNICALL
Java_io_github_muntashirakon_crypto_spake2_Spake2Context_process(JNIEnv* env, jclass, jlong handle, jbyteArray peer) {
    if (env->GetArrayLength(peer) > SPAKE2_MAX_MSG_SIZE) return nullptr;
    auto message = bytes(env, peer); uint8_t key[SPAKE2_MAX_KEY_SIZE]; size_t size = 0;
    int ok = SPAKE2_process_msg(reinterpret_cast<SPAKE2_CTX*>(handle), key, &size, sizeof(key), message.data(), message.size());
    auto output = ok == 1 ? result(env, key, size) : nullptr;
    OPENSSL_cleanse(key, sizeof(key)); return output;
}
extern "C" JNIEXPORT void JNICALL
Java_io_github_muntashirakon_crypto_spake2_Spake2Context_free(JNIEnv*, jclass, jlong handle) { SPAKE2_CTX_free(reinterpret_cast<SPAKE2_CTX*>(handle)); }

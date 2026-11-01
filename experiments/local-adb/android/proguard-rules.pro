# Shell entry point is launched by class name outside the APK's application process.
-keep class com.yepcontrol.adbspike.ShellHelper { *; }
-keep class com.yepcontrol.adbspike.Wire { *; }
# Keep the same native acceptance harness usable against the size-measurement APK.
-keep class com.yepcontrol.adbspike.** { *; }
# libadb selects the bundled provider/exporter by name; do not fall back to hidden platform APIs.
-keep class org.conscrypt.OpenSSLProvider { public <init>(); }
-keep class org.conscrypt.Conscrypt { public static *** exportKeyingMaterial(...); }
-keepclasseswithmembers,includedescriptorclasses class * { native <methods>; }
# Conscrypt's pre-Android-5 adapters are unreachable at this experiment's API-30 floor.
-dontwarn com.android.org.conscrypt.SSLParametersImpl
-dontwarn org.apache.harmony.xnet.provider.jsse.SSLParametersImpl
# Compile-time annotations referenced by AndroidX's instrumentation runner.
-dontwarn com.google.errorprone.annotations.CanIgnoreReturnValue
-dontwarn com.google.errorprone.annotations.MustBeClosed

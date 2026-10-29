import java.net.URI
import java.util.Properties

plugins {
    id("com.android.application")
    id("com.google.devtools.ksp")
    id("org.jlleitschuh.gradle.ktlint")
    id("com.google.gms.google-services")
}

fun requireOrigin(value: String) {
    val uri = URI(value)
    require(
        uri.scheme == "https" &&
            uri.host != null &&
            uri.rawUserInfo == null &&
            uri.rawQuery == null &&
            uri.rawFragment == null &&
            uri.rawPath.isNullOrEmpty(),
    ) { "Expected an HTTPS origin without a trailing slash: $value" }
}
val sharingWebsite = providers.gradleProperty("sharingWebsite").orElse("https://yepcontrol.com").get()
requireOrigin(sharingWebsite)
// Optional local relay (e.g. `pnpm dev` over Tailscale); debug builds offer it as a Settings switch.
val localProperties =
    Properties().apply {
        rootProject
            .file("local.properties")
            .takeIf { it.exists() }
            ?.reader()
            ?.use { load(it) }
    }
val devSharingWebsite =
    providers.gradleProperty("devSharingWebsite").orNull ?: localProperties.getProperty("devSharingWebsite", "")
if (devSharingWebsite.isNotEmpty()) requireOrigin(devSharingWebsite)

// Private, debug-only Cloudflare acceptance fixture. Never embedded in release builds.
val proofKeyFile = providers.environmentVariable("YEP_PROOF_RELAY_KEY_FILE").orNull
val proofKey = proofKeyFile?.let { file(it).readText().trim() }.orEmpty()
if (proofKey.isNotEmpty()) {
    require(proofKey.matches(Regex("[0-9a-f]{64}")) && URI(sharingWebsite).host.endsWith(".workers.dev"))
}

val releaseVersion = Properties().apply { rootProject.file("version.properties").reader().use { load(it) } }

android {
    namespace = "dev.remoteaccess.app"
    compileSdk = 37
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "com.yepcontrol.app"
        minSdk = 30
        // Keep beta runtime behavior at API 36 until Android 17 target changes are qualified.
        //noinspection OldTargetApi
        targetSdk = 36
        versionCode = releaseVersion.getProperty("VERSION_CODE").toInt()
        versionName = releaseVersion.getProperty("VERSION_NAME")
        buildConfigField("String", "SHARING_WEBSITE", "\"$sharingWebsite\"")
        buildConfigField("String", "DEV_SHARING_WEBSITE", "\"\"")
        buildConfigField("boolean", "PROOF_RELAY", "false")
        buildConfigField("String", "PROOF_RELAY_KEY", "\"\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        getByName("debug") {
            buildConfigField("String", "DEV_SHARING_WEBSITE", "\"$devSharingWebsite\"")
            buildConfigField("boolean", "PROOF_RELAY", proofKey.isNotEmpty().toString())
            buildConfigField("String", "PROOF_RELAY_KEY", "\"$proofKey\"")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["androidTest"].assets.directories.add("../../protocol/vectors")
    sourceSets["androidTest"].assets.directories.add("$projectDir/schemas")
    lint {
        abortOnError = true
        warningsAsErrors = true
    }
}
ksp { arg("room.schemaLocation", "$projectDir/schemas") }
kotlin { compilerOptions { allWarningsAsErrors.set(true) } }
dependencies {
    // Native modal navigation drawer, with RTL and accessibility support.
    implementation("androidx.drawerlayout:drawerlayout:1.2.0")
    // Reviewed Apache-2.0 QR encoder for locally approved, one-use pairing links.
    //noinspection NewerVersionAvailable
    implementation("com.google.zxing:core:3.5.4")
    // Unused-app restrictions and their system settings entry point.
    //noinspection GradleDependency
    implementation("androidx.core:core:1.19.1")
    // Keep the Room runtime, compiler and test helper on the same version.
    //noinspection GradleDependency
    implementation("androidx.room:room-runtime:2.8.5")
    // Room migration serializers and the app must use the same runtime ABI.
    implementation(platform("org.jetbrains.kotlinx:kotlinx-serialization-bom:1.12.0"))
    // Predictive back support.
    //noinspection GradleDependency
    implementation("androidx.activity:activity:1.10.1")
    // Upgrade scanner transitive Fragment to the ActivityResult-compatible API.
    //noinspection GradleDependency
    implementation("androidx.fragment:fragment:1.9.1")
    //noinspection GradleDependency
    ksp("androidx.room:room-compiler:2.8.5")
    // Pinned to the reviewed installation-registration API.
    //noinspection GradleDependency
    implementation(platform("com.google.firebase:firebase-bom:34.16.0"))
    implementation("com.google.firebase:firebase-messaging")
    // Background work scheduling.
    //noinspection GradleDependency
    implementation("androidx.work:work-runtime:2.12.0")
    androidTestImplementation(kotlin("test"))
    // Match the Room runtime used above.
    //noinspection GradleDependency
    androidTestImplementation("androidx.room:room-testing:2.8.5")
    // Data channels only. Exact AAR/license review: docs/direct-transport.md.
    //noinspection NewerVersionAvailable
    implementation("io.github.webrtc-sdk:android:150.7871.04")
    implementation(project(":protocol"))
    // OkHttp's Kotlin client API is exercised by hosted acceptance.
    //noinspection NewerVersionAvailable
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.4.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}

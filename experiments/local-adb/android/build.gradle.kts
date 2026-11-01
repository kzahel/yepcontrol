plugins { id("com.android.application") }

val baseline = providers.gradleProperty("localAdbBaseline").orNull == "true"
android {
    namespace = "com.yepcontrol.adbspike"
    compileSdk = 37
    defaultConfig {
        applicationId = if (baseline) "com.yepcontrol.adbspike.baseline" else "com.yepcontrol.adbspike"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "spike"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testProguardFiles("proguard-rules.pro")
        ndk { abiFilters.add(providers.gradleProperty("localAdbAbi").orNull ?: "arm64-v8a") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    if (baseline) {
        sourceSets["main"].java.setSrcDirs(listOf("src/baseline/java"))
        sourceSets["main"].manifest.srcFile("src/baseline/AndroidManifest.xml")
        sourceSets["debug"].java.setSrcDirs(emptyList<String>())
        sourceSets["debug"].manifest.srcFile("src/baseline/debug.xml")
    }
    buildTypes.named("debug") {
        isMinifyEnabled = providers.gradleProperty("localAdbMinify").orNull == "true"
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    lint { abortOnError = true }
}
dependencies {
    if (!baseline) {
        implementation("com.github.MuntashirAkon:libadb-android:3.1.1")
        implementation("org.bouncycastle:bcprov-jdk15to18:1.81")
        implementation("org.conscrypt:conscrypt-android:2.5.3")
    }
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}

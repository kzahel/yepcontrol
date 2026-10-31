plugins {
    id("com.android.application")
    id("org.jlleitschuh.gradle.ktlint")
}

android {
    namespace = "com.yepcontrol.mediaspike"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.yepcontrol.mediaspike"
        minSdk = 30
        targetSdk = 36 // Match the released host.
        versionCode = 1
        versionName = "spike"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
}

pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "remote-access"
include(":protocol", ":app")
// An opt-in, separately installed experiment; never part of the product APK.
if (providers.gradleProperty("mediaSpike").orNull == "true") {
    include(":media-spike")
    project(":media-spike").projectDir = file("../experiments/media-access/android")
}

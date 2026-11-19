#!/usr/bin/env python3
"""Reject unexpected permissions, incompatible TV filters and missing ARM libraries in release artifacts."""
from pathlib import Path
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ANDROID = "{http://schemas.android.com/apk/res/android}"
ALLOWED = {
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.WAKE_LOCK",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.FOREGROUND_SERVICE_CAMERA",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.WRITE_SECURE_SETTINGS",
    "com.google.android.c2dm.permission.RECEIVE",
    "com.yepcontrol.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
}


def verify(path):
    root = ET.parse(path).getroot()
    permissions = {
        node.get(ANDROID + "name") for node in root
        if node.tag.startswith("uses-permission")
    }
    unexpected = permissions - ALLOWED
    if unexpected:
        raise ValueError("Unexpected release permissions: " + ", ".join(sorted(unexpected)))
    features = {node.get(ANDROID + "name"): node.get(ANDROID + "required") for node in root.findall("uses-feature")}
    optional_tv_features = {
        "android.software.leanback",
        "android.hardware.touchscreen",
        "android.hardware.faketouch",
        "android.hardware.screen.portrait",
        "android.hardware.camera",
        "android.hardware.camera.any",
        "android.hardware.camera.autofocus",
        "android.hardware.camera.flash",
        "android.hardware.microphone",
    }
    if any(features.get(name) != "false" for name in optional_tv_features):
        raise ValueError("TV manifest must explicitly make touchscreen, leanback and sensor features optional")
    if any(required != "false" for required in features.values()):
        raise ValueError("Unexpected required feature in TV-compatible manifest")

    application = root.find("application")
    tv = next((node for node in application.findall("activity-alias")
               if node.get(ANDROID + "name") == "dev.remoteaccess.app.TvLauncher"), None)
    if (tv is None or tv.get(ANDROID + "exported") != "true" or not tv.get(ANDROID + "banner")
            or not tv.get(ANDROID + "icon") or not any(is_tv_launcher(node) for node in tv.findall("intent-filter"))):
        raise ValueError("TV launcher entry, icon or banner is missing")
    if not any(is_tv_launcher(node) for node in root.findall("./queries/intent")):
        raise ValueError("Leanback launcher query is missing")
    for tag, name, attributes in [
        ("provider", "BootstrapProvider", {"exported": "true", "permission": "android.permission.DUMP"}),
        ("service", "AdvancedService", {"exported": "false", "foregroundServiceType": "specialUse"}),
        ("receiver", "PairReceiver", {"exported": "false"}),
    ]:
        component = next((node for node in application.findall(tag)
                          if node.get(ANDROID + "name") == "dev.remoteaccess.app.advanced." + name), None)
        if component is None or any(component.get(ANDROID + key) != value for key, value in attributes.items()):
            raise ValueError("Invalid advanced component boundary: " + name)


def is_tv_launcher(node):
    return (node.find(f"action[@{ANDROID}name='android.intent.action.MAIN']") is not None
            and node.find(f"category[@{ANDROID}name='android.intent.category.LEANBACK_LAUNCHER']") is not None)


def verify_native_bundle(path):
    required = {"libjingle_peerconnection_so.so", "libyep_pairing.so",
                "libconscrypt_jni.so", "libdatastore_shared_counter.so"}
    with ZipFile(path) as bundle:
        libs = {}
        for entry in bundle.namelist():
            parts = entry.split("/")
            if len(parts) == 4 and parts[:2] == ["base", "lib"] and entry.endswith(".so"):
                libs.setdefault(parts[2], set()).add(parts[3])
    if (not required.issubset(libs.get("armeabi-v7a", set()))
            or libs.get("armeabi-v7a") != libs.get("arm64-v8a")):
        raise ValueError("Release bundle must contain matching native libraries for 32-bit and 64-bit ARM")


if __name__ == "__main__":
    build = Path(__file__).resolve().parents[1] / "android/app/build"
    verify(build / "intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml")
    verify_native_bundle(build / "outputs/bundle/release/app-release.aab")
    print("Merged release permissions, advanced boundaries, TV launcher and ARM native libraries verified")

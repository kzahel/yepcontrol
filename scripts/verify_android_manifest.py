#!/usr/bin/env python3
"""Reject accidental permissions in the actual merged Play release manifest."""
from pathlib import Path
import xml.etree.ElementTree as ET

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
    application = root.find("application")
    for tag, name, attributes in [
        ("provider", "BootstrapProvider", {"exported": "true", "permission": "android.permission.DUMP"}),
        ("service", "AdvancedService", {"exported": "false", "foregroundServiceType": "specialUse"}),
        ("receiver", "PairReceiver", {"exported": "false"}),
    ]:
        component = next((node for node in application.findall(tag)
                          if node.get(ANDROID + "name") == "dev.remoteaccess.app.advanced." + name), None)
        if component is None or any(component.get(ANDROID + key) != value for key, value in attributes.items()):
            raise ValueError("Invalid advanced component boundary: " + name)


if __name__ == "__main__":
    path = Path(__file__).resolve().parents[1] / "android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml"
    verify(path)
    print("Merged release permissions and advanced component boundaries verified")

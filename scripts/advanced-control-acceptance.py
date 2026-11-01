#!/usr/bin/env python3
"""Own an emulator; never select a physical phone. Build APKs before running."""
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".local/advanced-control/emulator"
SDK = Path(os.environ.get("ANDROID_HOME", Path.home() / "Android/Sdk"))
ADB = str(SDK / "platform-tools/adb")
PORT = 5606
SERIAL = f"emulator-{PORT}"
APP = "com.yepcontrol.app"
os.umask(0o077)
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
for stale in ["result.json", "setupOnPhone.txt", "pairingPrimitive.txt", "failure-ui.xml"]:
    (STATE / stale).unlink(missing_ok=True)
ENV = os.environ | {"ANDROID_AVD_HOME": str(STATE / "avd"), "ANDROID_EMULATOR_HOME": str(STATE / "emulator")}
for key in ["ANDROID_AVD_HOME", "ANDROID_EMULATOR_HOME"]:
    Path(ENV[key]).mkdir(parents=True, exist_ok=True)


def adb(*args, timeout=30):
    return subprocess.check_output([ADB, "-s", SERIAL, *args], text=True, timeout=timeout, stderr=subprocess.STDOUT).strip()


def wait(label, predicate, seconds=150):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (subprocess.SubprocessError, ValueError, KeyError):
            pass
        time.sleep(1)
    raise RuntimeError(label)


def test(method):
    value = adb("shell", "am", "instrument", "-w", "-r", "-e", "class", "dev.remoteaccess.app.advanced.AdvancedAcceptance#" + method, APP + ".test/androidx.test.runner.AndroidJUnitRunner", timeout=210)
    (STATE / (method + ".txt")).write_text(value)
    if "OK (1 test)" not in value:
        try: (STATE / "failure-ui.xml").write_text(adb("exec-out", "run-as", APP, "cat", "no_backup/advanced-test-ui.xml"))
        except Exception: pass
        raise RuntimeError("Native acceptance failed; inspect private " + method + " log")

assert f"{SERIAL}\t" not in subprocess.check_output([ADB, "devices"], text=True), "Refusing occupied emulator selector"
for port in [PORT, PORT + 1]:
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", port))
abi = "arm64-v8a" if platform.machine() == "arm64" else "x86_64"
avd = "yep-advanced-acceptance"
if not (Path(ENV["ANDROID_AVD_HOME"]) / f"{avd}.ini").exists():
    subprocess.run([str(SDK / "cmdline-tools/latest/bin/avdmanager"), "create", "avd", "--name", avd, "--package", f"system-images;android-36;google_apis;{abi}", "--device", "pixel_7"], env=ENV, input="no\n", text=True, check=True, capture_output=True)
apks = ROOT / "android/app/build/outputs/apk"
for source, destination, package in [
    (apks / "debug/app-debug.apk", "host.apk", APP),
    (apks / "androidTest/debug/app-debug-androidTest.apk", "tests.apk", f"{APP}.test"),
]:
    target = STATE / destination
    shutil.copyfile(source, target)
    badging = subprocess.check_output([str(SDK / "build-tools/36.0.0/aapt2"), "dump", "badging", str(target)], text=True)
    assert f"package: name='{package}'" in badging, "Unexpected APK package"

result = {"platform": "Android 16 / API 36 owned emulator"}
with (STATE / "emulator.log").open("w") as log:
    emulator = subprocess.Popen([str(SDK / "emulator/emulator"), "-avd", avd, "-port", str(PORT), "-wipe-data", "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect"], env=ENV, stdout=log, stderr=log)
    try:
        wait("Emulator did not boot", lambda: adb("shell", "getprop", "sys.boot_completed") == "1")
        assert adb("shell", "getprop", "ro.kernel.qemu") == "1"
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
        adb("shell", "settings", "put", "system", "screen_off_timeout", "1800000")
        for file in ["host.apk", "tests.apk"]: adb("install", "-t", str(STATE / file))
        test("pairingPrimitive")
        test("setupOnPhone")
        result.update(pairingPrimitive=True, phoneOnlySetup=True, shellAttestation=True, protectedCounterInput=True, identityWrapped=True, stopPreservesPairing=True, helperEndpointClosed=True, multiContactExpiryCancelled=True, staleContinuationRejected=True)
        # Instrumentation stops its target. Clear that state before boot so this
        # check would catch an accidentally added boot receiver.
        adb("shell", "am", "start", "-W", "-n", APP + "/dev.remoteaccess.app.MainActivity")
        before = adb("exec-out", "run-as", APP, "cat", "shared_prefs/advanced.xml")
        boot = int(adb("shell", "settings", "get", "global", "boot_count"))
        adb("reboot")
        wait("Emulator did not reboot", lambda: adb("shell", "getprop", "sys.boot_completed") == "1" and int(adb("shell", "settings", "get", "global", "boot_count")) > boot)
        assert "AdvancedService" not in adb("shell", "dumpsys", "activity", "services", APP)
        assert adb("exec-out", "run-as", APP, "cat", "shared_prefs/advanced.xml") == before
        result.update(noBootArming=True)
        (STATE / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    finally:
        try: adb("emu", "kill")
        except Exception: emulator.terminate()
        try: emulator.wait(timeout=15)
        except subprocess.TimeoutExpired: emulator.kill(); emulator.wait()

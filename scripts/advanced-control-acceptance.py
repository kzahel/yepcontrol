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
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".local/advanced-control/emulator"
SDK = Path(os.environ.get("ANDROID_HOME", Path.home() / "Android/Sdk"))
ADB = str(SDK / "platform-tools/adb")
PORT = 5606
SERIAL = f"emulator-{PORT}"
APP = "com.yepcontrol.app"
os.umask(0o077)
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
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
        # Only static failure metadata leaves the private evidence directory.
        failure = re.search(r"^INSTRUMENTATION_(?:STATUS: stack|RESULT: shortMsg)=(.*)$", value, re.M)
        if failure:
            safe = re.sub(r"[A-Za-z0-9+/_=-]{32,}|\b[0-9]{6}\b", "<redacted>", failure.group(1)[:240])
            print("Native failure: " + safe, flush=True)
        for frame in re.findall(r"^\s*at (dev\.remoteaccess\.[^\r\n]+)$", value, re.M)[:4]:
            print("Native frame: " + frame[:200], flush=True)
        try:
            raw_ui = adb("exec-out", "run-as", APP, "cat", "no_backup/advanced-test-ui.xml")
            (STATE / "failure-ui.xml").write_text(raw_ui)
            nodes = list(ET.fromstring(raw_ui).iter("node"))
            # Only static package/resource identifiers leave private evidence.
            # Never emit text, descriptions, pairing codes or arbitrary attributes.
            packages = sorted({n.get("package", "") for n in nodes
                               if re.fullmatch(r"[a-zA-Z0-9_.]+", n.get("package", ""))})
            ids = sorted({n.get("resource-id", "") for n in nodes
                          if re.fullmatch(r"[a-zA-Z0-9_.]+:id/[a-zA-Z0-9_]+", n.get("resource-id", ""))})
            print("Native UI identifiers: " + json.dumps({"packages": packages, "ids": ids[:60]}), flush=True)
        except Exception: pass
        try:
            activity = adb("shell", "dumpsys", "activity", "activities")
            components = re.findall(r"(?:topResumedActivity|mResumedActivity)[=:].*? ([a-zA-Z0-9_.]+/[a-zA-Z0-9_.$]+)", activity)
            power = adb("shell", "dumpsys", "power")
            awake = re.findall(r"mWakefulness=([a-zA-Z]+)", power)
            print("Native presentation: " + json.dumps({"resumed": components, "wakefulness": awake}), flush=True)
        except Exception: pass
        try:
            anr = adb("shell", "dumpsys", "activity", "lastanr")
            (STATE / "last-anr.txt").write_text(anr)
            processes = re.findall(r"ANR in ([a-zA-Z0-9_.]+)", anr)
            frames = re.findall(r"^\s*at ((?:android|com\.android|java|javax)\.[a-zA-Z0-9_.$]+\([^\r\n]*\))$", anr, re.M)
            print("Native ANR: " + json.dumps({"processes": processes, "frames": frames[:20]}), flush=True)
        except Exception: pass
        raise RuntimeError("Native acceptance failed; inspect private " + method + " log")

def process_death():
    with (STATE / "process-death.txt").open("w") as output:
        command = [ADB, "-s", SERIAL, "shell", "am", "instrument", "-w", "-r", "-e", "class",
                   "dev.remoteaccess.app.advanced.AdvancedAcceptance#holdForProcessDeath",
                   APP + ".test/androidx.test.runner.AndroidJUnitRunner"]
        running = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT)
        forwarded = None
        try:
            receipt = wait("Process-death fixture did not become ready",
                           lambda: json.loads(adb("exec-out", "run-as", APP, "cat", "no_backup/advanced-process-death.json")), 100)
            port = receipt["port"]
            pid = receipt["pid"]
            assert isinstance(pid, int) and 0 < pid <= 2**22
            assert isinstance(port, int) and 1024 <= port <= 65535
            forwarded = int(adb("forward", "tcp:0", f"tcp:{port}"))

            def listening():
                try:
                    with socket.create_connection(("127.0.0.1", forwarded), timeout=1) as probe:
                        probe.settimeout(1)
                        # Forwarding accepts even with no remote server. A real
                        # helper sends its challenge; no authentication is sent.
                        return bool(probe.recv(1))
                except (OSError, TimeoutError):
                    return False

            wait("Process-death fixture endpoint was not live", listening, 10)
            adb("shell", "am", "force-stop", APP)
            # The instrumentation watcher is deliberately interrupted. Reap
            # only this owned adb client; never affect the shared adb server.
            running.terminate()
            try: running.wait(timeout=5)
            except subprocess.TimeoutExpired: running.kill(); running.wait()
            def helper_gone():
                try:
                    adb("shell", "kill", "-0", str(pid))
                    return False
                except subprocess.CalledProcessError:
                    return not listening()

            wait("Helper outlived its process-death lease", helper_gone, 40)
            # Restarting the normal app must not re-arm it either.
            adb("shell", "am", "start", "-W", "-n", APP + "/dev.remoteaccess.app.MainActivity")
            assert "AdvancedService" not in adb("shell", "dumpsys", "activity", "services", APP)
        finally:
            if forwarded is not None:
                adb("forward", "--remove", f"tcp:{forwarded}")
            if running.poll() is None:
                adb("shell", "am", "force-stop", APP)
                running.terminate()
                try: running.wait(timeout=5)
                except subprocess.TimeoutExpired: running.kill(); running.wait()


assert f"{SERIAL}\t" not in subprocess.check_output([ADB, "devices"], text=True), "Refusing occupied emulator selector"
for port in [PORT, PORT + 1]:
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", port))
for stale in ["result.json", "setupOnPhone.txt", "pairingPrimitive.txt", "failure-ui.xml", "staleStartCannotPublishReadiness.txt"]:
    (STATE / stale).unlink(missing_ok=True)
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
resources = {"hostCpuCount": os.cpu_count()}
if Path("/proc/meminfo").exists():
    available = re.search(r"^MemAvailable:\s+(\d+) kB", Path("/proc/meminfo").read_text(), re.M)
    if available: resources["hostAvailableKiB"] = int(available.group(1))
print("Owned emulator resources: " + json.dumps(resources), flush=True)
with (STATE / "emulator.log").open("w") as log:
    emulator = subprocess.Popen([str(SDK / "emulator/emulator"), "-avd", avd, "-port", str(PORT), "-wipe-data", "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader", "-feature", "-Vulkan"], env=ENV, stdout=log, stderr=log)
    try:
        wait("Emulator did not boot", lambda: adb("shell", "getprop", "sys.boot_completed") == "1")
        assert adb("shell", "getprop", "ro.kernel.qemu") == "1"
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
        adb("shell", "settings", "put", "system", "screen_off_timeout", "1800000")
        for animation in ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]:
            adb("shell", "settings", "put", "global", animation, "0")
        adb("shell", "svc", "wifi", "enable")
        wait("Owned Wi-Fi fixture did not associate", lambda: "connected" in (v := adb("shell", "cmd", "wifi", "status").lower()) and "disconnected" not in v)
        for file in ["host.apk", "tests.apk"]: adb("install", "-t", str(STATE / file))
        test("pairingPrimitive")
        test("staleStartCannotPublishReadiness")
        test("setupOnPhone")
        result.update(staleStartRejected=True, pairingPrimitive=True, phoneOnlySetup=True, shellAttestation=True, protectedCounterInput=True, identityWrapped=True, stopPreservesPairing=True, helperEndpointClosed=True, multiContactExpiryCancelled=True, staleContinuationRejected=True)
        process_death()
        result.update(processDeathLeaseExpired=True, noProcessRestartArming=True)
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

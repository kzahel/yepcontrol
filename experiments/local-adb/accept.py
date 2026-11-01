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

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".local/local-adb-acceptance"
SDK = Path(os.environ.get("ANDROID_HOME", Path.home() / "Android/Sdk"))
ADB = str(SDK / "platform-tools/adb")
PORT = 5604
SERIAL = f"emulator-{PORT}"
APP = "com.yepcontrol.adbspike"
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


def status():
    return json.loads(adb("exec-out", "run-as", APP, "cat", "no_backup/status.json"))


def ready(boot=None):
    value = status()
    uptime = float(adb("shell", "cat", "/proc/uptime").split()[0]) * 1000
    return value if value["phase"] == "ready" and 0 <= uptime - value["elapsedMs"] < 10000 and (boot is None or value["boot"] > boot) else False


def test(method):
    if method in ["helperTap", "setupAndProtectedInput"]:
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
    # The setup harness owns UiAutomation. Helper snapshots use later debug probes.
    result = adb("shell", "am", "instrument", "-w", "-r", "-e", "class", f"{APP}.SpikeAcceptance#{method}", f"{APP}.test/androidx.test.runner.AndroidJUnitRunner", timeout=180)
    (STATE / f"{method}.txt").write_text(result)
    if "OK (1 test)" not in result:
        raise RuntimeError(f"Phone-side {method} failed; see private receipt")


def restart_service():
    # Launch normal UI to recover from instrumentation's intentional target-process teardown.
    # This is NOT used after reboot: BOOT_COMPLETED must do that by itself.
    adb("shell", "am", "start", "-n", f"{APP}/.MainActivity")


def probe(op):
    identity = str(uuid.uuid4())
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    adb("shell", "wm", "dismiss-keyguard")
    # Each probe needs onCreate, even if an earlier probe left its protected child on top.
    adb("shell", "am", "start", "-f", "0x18000000", "-n", f"{APP}/.ProbeActivity", "--es", "op", op, "--es", "id", identity)
    def received():
        v = json.loads(adb("exec-out", "run-as", APP, "cat", "no_backup/probe.json"))
        return v if v["id"] == identity else False
    value = wait("Probe timed out", received, seconds=20)
    assert value["ok"], value
    return value


assert f"{SERIAL}\t" not in subprocess.check_output([ADB, "devices"], text=True), "Refusing occupied emulator selector"
for port in [PORT, PORT + 1]:
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", port))
abi = "arm64-v8a" if platform.machine() == "arm64" else "x86_64"
avd = "yep-local-adb-acceptance"
if not (Path(ENV["ANDROID_AVD_HOME"]) / f"{avd}.ini").exists():
    subprocess.run([str(SDK / "cmdline-tools/latest/bin/avdmanager"), "create", "avd", "--name", avd, "--package", f"system-images;android-36;google_apis;{abi}", "--device", "pixel_7"], env=ENV, input="no\n", text=True, check=True, capture_output=True)
apks = ROOT / "experiments/local-adb/android/build/outputs/apk"
for source, destination, package in [
    (apks / "debug/local-adb-spike-debug.apk", "host.apk", APP),
    (apks / "androidTest/debug/local-adb-spike-debug-androidTest.apk", "tests.apk", f"{APP}.test"),
]:
    target = STATE / destination
    shutil.copyfile(source, target)
    badging = subprocess.check_output([str(SDK / "build-tools/36.0.0/aapt2"), "dump", "badging", str(target)], text=True)
    assert f"package: name='{package}'" in badging, "Unexpected APK package"

result = {"platform": "Android 16 / API 36 owned emulator", "computerPairOrGrant": False, "reboots": []}
with (STATE / "emulator.log").open("w") as log:
    emulator = subprocess.Popen([str(SDK / "emulator/emulator"), "-avd", avd, "-port", str(PORT), "-wipe-data", "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect"], env=ENV, stdout=log, stderr=log)
    try:
        wait("Emulator did not boot", lambda: adb("shell", "getprop", "sys.boot_completed") == "1")
        assert adb("shell", "getprop", "ro.kernel.qemu") == "1"
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
        adb("shell", "settings", "put", "system", "screen_off_timeout", "1800000")
        for file in ["host.apk", "tests.apk"]:
            adb("install", "-t", str(STATE / file))
        # Default-off must survive boot with no identity, service, helper or settings grant.
        adb("shell", "am", "start", "-n", f"{APP}/.MainActivity")
        off = wait("Default-off receipt not written", status, seconds=30)
        assert not off["enabled"] and not off["paired"] and not off["settingsGrant"]
        assert "AdvancedService" not in adb("shell", "dumpsys", "activity", "services", APP)
        result["defaultOff"] = off
        test("setupAndProtectedInput")
        result["ordinaryInput"] = json.loads(adb("exec-out", "run-as", APP, "cat", "no_backup/ordinary-input.json"))
        # Instrumentation owns the global UiAutomation singleton until it exits.
        # Acquire a sensitivity snapshot only afterward, with no instrumentation involved.
        restart_service()
        wait("Service restart after instrumentation failed", ready)
        result["protectedInput"] = probe("sensitivity-and-tap")
        for cycle in range(3):
            previous = status()
            started = time.monotonic()
            adb("reboot")
            # No launch, settings write, grant or pairing during recovery. No secure lock on this emulator.
            recovered = wait("Automatic recovery failed", lambda: ready(previous["boot"]), seconds=180)
            assert recovered["identity"] == previous["identity"] and recovered["settingsGrant"]
            result["reboots"].append({"seconds": round(time.monotonic() - started, 2), "status": recovered})
            probe("tap")
        # Capture process footprint; this is not a battery benchmark.
        for name, selector in [("app", APP), ("helper", str(status()["helperPid"]))]:
            memory = adb("shell", "dumpsys", "meminfo", selector)
            (STATE / f"{name}-memory.txt").write_text(memory)
            match = re.search(r"TOTAL PSS:\s*(\d+)", memory)
            result[f"{name}PssKiB"] = int(match.group(1)) if match else None
        # Outages are induced on this disposable fixture. They do not bootstrap pairing or grants.
        wait("Service did not recover after instrumentation", ready)
        before = status()
        adb("shell", "svc", "wifi", "disable")
        time.sleep(7)
        tap = probe("tap")
        assert tap["helperPid"] == before["helperPid"]
        result["wifiOffHelperInput"] = True
        adb("shell", "svc", "wifi", "enable")
        wait("Wi-Fi recovery failed", ready)
        # Stop helper while Wi-Fi is unavailable, then require app-local listener/helper restart.
        adb("shell", "svc", "wifi", "disable")
        stopped = probe("stop-helper")
        time.sleep(7)
        adb("shell", "svc", "wifi", "enable")
        recovered = wait("Helper restart after Wi-Fi loss failed", lambda: (v := ready()) and v["helperPid"] != stopped["oldPid"] and v)
        result["wifiAndHelperRecovery"] = recovered
        probe("tap")
        wait("Service did not recover", ready)
        # Turn off the ADB listener and stop helper: the app must request its own restart.
        adb("shell", "settings", "put", "global", "adb_wifi_enabled", "0")
        stopped = probe("stop-helper")
        recovered = wait("Listener recovery failed", lambda: (v := ready()) and v["helperPid"] != stopped["oldPid"] and v)
        result["listenerRecovery"] = recovered
        # The helper must expire after app force-stop, rather than survive unattended forever.
        old_pid = recovered["helperPid"]
        started = time.monotonic()
        adb("shell", "am", "force-stop", APP)
        wait("Orphan helper did not expire", lambda: adb("shell", f"if test -d /proc/{old_pid}; then echo alive; else echo gone; fi") == "gone", seconds=45)
        result["orphanLeaseSeconds"] = round(time.monotonic() - started, 2)
        restart_service()
        wait("Explicit app restart did not recover", lambda: (v := ready()) and v["helperPid"] != old_pid and v)
        probe("off")
        boot = status()["boot"]
        adb("reboot")
        wait("Off-state reboot failed", lambda: adb("shell", "getprop", "sys.boot_completed") == "1")
        time.sleep(10)
        assert "AdvancedService" not in adb("shell", "dumpsys", "activity", "services", APP)
        # The off-state boot guard starts no worker and writes no readiness receipt.
        assert status()["boot"] == boot and not status()["enabled"]
        result["offAfterReboot"] = True
        result["passed"] = True
        (STATE / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps({"passed": True, "rebootSeconds": [v["seconds"] for v in result["reboots"]], "receipts": str(STATE)}))
    finally:
        (STATE / "last-run.json").write_text(json.dumps(result, indent=2))
        try:
            (STATE / "logcat-private.txt").write_text(adb("logcat", "-d"))
            with (STATE / "final-screen-private.png").open("wb") as capture:
                subprocess.run([ADB, "-s", SERIAL, "exec-out", "screencap", "-p"], stdout=capture, stderr=subprocess.DEVNULL, timeout=15)
        except subprocess.SubprocessError:
            pass
        # No shared adb-server shutdown. Only this newly owned emulator is reaped.
        try:
            adb("emu", "kill")
        except subprocess.SubprocessError:
            pass
        try:
            emulator.wait(timeout=15)
        except subprocess.TimeoutExpired:
            emulator.terminate()
            emulator.wait(timeout=10)

/** Public-origin acceptance with an owned emulator or explicitly selected physical fixture. */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { decodeInvitation } from "../protocol/src/enrollment.js";
import {
  nativeFailure,
  safeFixtureDiagnostics,
} from "./acceptance-diagnostics.js";
import { candidateViewer } from "./candidate-viewer.js";
import { controlAcceptance } from "./control-acceptance.js";
import { mobileAcceptance } from "./mobile-management-acceptance.js";
import { admitProofBrowser } from "./proof-relay.js";
import { restoreSyntheticLock } from "./synthetic-lock.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.HOSTED_ORIGIN;
if (
  !origin ||
  new URL(origin).origin !== origin ||
  !origin.startsWith("https://")
)
  throw new Error("Set HOSTED_ORIGIN to the HTTPS development relay origin");
const control = process.argv.includes("--control");
const pairingOnly = process.argv.includes("--pairing-only");
const multi =
  pairingOnly ||
  process.env.HOSTED_MULTI === "1" ||
  process.argv.includes("--multi");
const physical = process.env.HOSTED_DEVICE;
if (multi && physical)
  throw new Error("Multi-browser acceptance owns an emulator only");
if (
  control &&
  physical &&
  [
    "HOSTED_CLI",
    "HOSTED_UNLOCK",
    "HOSTED_CONTROL_WAKE",
    "HOSTED_BOOT",
    "HOSTED_ROTATION",
  ].some((key) => process.env[key] === "1")
)
  throw new Error(
    "Physical control excludes credential, reboot, idle/unlock and orientation fixtures",
  );
const expectedModel = process.env.HOSTED_DEVICE_MODEL;
const doze = process.env.HOSTED_DOZE === "1";
if (physical && (!expectedModel || physical.startsWith("emulator-")))
  throw new Error(
    "Physical acceptance requires an exact device and expected model",
  );
if (doze && (!physical || process.env.HOSTED_FCM !== "1"))
  throw new Error("Doze acceptance requires physical FCM mode");
const state = process.env.HOSTED_STATE_DIRECTORY
  ? path.resolve(process.env.HOSTED_STATE_DIRECTORY)
  : path.join(
      root,
      control
        ? physical
          ? ".local/physical-control-proof"
          : ".local/control-proof"
        : multi
          ? ".local/mobile-proof"
          : physical
            ? ".local/physical-hosted-proof"
            : ".local/hosted-proof",
    );
if (physical && process.env.HOSTED_STATE_DIRECTORY)
  throw new Error("Custom state directories require an owned emulator");
const fcm = process.env.HOSTED_FCM === "1";
const migration = process.env.HOSTED_MIGRATION === "1";
if (migration && (physical || control || multi || !fcm))
  throw new Error(
    "Migration acceptance requires the owned pairing/FCM fixture",
  );
const sdk = process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk");
const adbPath = path.join(sdk, "platform-tools/adb");
const port = Number(process.env.HOSTED_EMULATOR_PORT ?? 5594);
if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2)
  throw new Error("HOSTED_EMULATOR_PORT must be an even emulator port");
const serial = physical ?? `emulator-${port}`;
const appId = "com.yepcontrol.app";
const env = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_AVD_HOME: path.join(state, "avd"),
  ANDROID_EMULATOR_HOME: path.join(state, "emulator"),
};
const adb = (...args: string[]) =>
  execFileSync(adbPath, ["-s", serial, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: args.includes("instrument") ? 120000 : 20000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  work: () => T | Promise<T>,
  timeout = 120000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const result = await work();
      if (result) return result;
    } catch {}
    await delay(400);
  }
  throw new Error("Hosted acceptance timed out; see private fixture logs");
}
async function unused(value: number) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(value, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
let previousActivity: string | undefined;
if (physical) {
  if (
    adb("shell", "getprop", "ro.kernel.qemu") === "1" ||
    adb("shell", "getprop", "ro.product.model") !== expectedModel ||
    adb("shell", "am", "get-current-user") !== "0"
  )
    throw new Error("Physical target identity/user mismatch");
  const keyguard = adb("shell", "dumpsys", "window", "policy").match(
    /KeyguardServiceDelegate[\s\S]*?\bshowing=(true|false)/,
  )?.[1];
  if (
    keyguard !== "false" ||
    !adb("shell", "dumpsys", "power").includes("mWakefulness=Awake")
  )
    throw new Error(
      "Unlock the selected physical phone locally before acceptance",
    );
  for (const pkg of [appId, `${appId}.test`]) {
    if (
      !adb("shell", "dumpsys", "package", pkg).includes(
        "Unable to find package",
      )
    )
      throw new Error("Refusing to replace an existing physical test package");
  }
  previousActivity = adb("shell", "dumpsys", "activity", "activities").match(
    /topResumedActivity=ActivityRecord\{[^}]* u0 ([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)/,
  )?.[1];
  const idle = adb("shell", "dumpsys", "deviceidle");
  const battery = adb("shell", "dumpsys", "battery");
  if (
    doze &&
    (!idle.includes("mForceIdle=false") ||
      !idle.includes("mState=ACTIVE") ||
      battery.includes("UPDATES STOPPED"))
  )
    throw new Error("Refusing to replace existing battery/idle overrides");
}
await mkdir(state, { recursive: true, mode: 0o700 });
let log: Awaited<ReturnType<typeof open>> | undefined;
let emulator: ReturnType<typeof spawn> | undefined;
if (!physical) {
  await mkdir(env.ANDROID_AVD_HOME, { recursive: true });
  await mkdir(env.ANDROID_EMULATOR_HOME, { recursive: true });
  if (
    execFileSync(adbPath, ["devices"], { encoding: "utf8" }).includes(
      `${serial}\t`,
    )
  )
    throw new Error("Refusing occupied emulator selector");
  await unused(port);
  await unused(port + 1);
  const avd = "remote-hosted-api35";
  if (!existsSync(path.join(env.ANDROID_AVD_HOME, `${avd}.ini`)))
    execFileSync(
      path.join(sdk, "cmdline-tools/latest/bin/avdmanager"),
      [
        "create",
        "avd",
        "--name",
        avd,
        "--package",
        `system-images;android-35;google_apis;${os.arch() === "arm64" ? "arm64-v8a" : "x86_64"}`,
        "--device",
        "pixel_7",
        "--path",
        path.join(env.ANDROID_AVD_HOME, `${avd}.avd`),
      ],
      { env, input: "no\n", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] },
    );
  log = await open(path.join(state, "emulator.log"), "w", 0o600);
  emulator = spawn(
    path.join(sdk, "emulator/emulator"),
    [
      "-avd",
      avd,
      "-port",
      String(port),
      "-no-window",
      "-no-audio",
      "-no-snapshot",
      "-gpu",
      process.env.HOSTED_EMULATOR_GPU ?? "swiftshader",
      "-dns-server",
      process.env.HOSTED_DNS_SERVERS ?? "1.1.1.1,8.8.8.8",
      "-no-boot-anim",
    ],
    { env, stdio: ["ignore", log.fd, log.fd] },
  );
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let instrument: ReturnType<typeof spawn> | undefined;
const logs: Awaited<ReturnType<typeof open>>[] = [];
const privateWrite = (file: string, value: string) => {
  if (!/^[a-z-]+$/.test(file)) throw new Error("Invalid fixture filename");
  return execFileSync(
    adbPath,
    [
      "-s",
      serial,
      "shell",
      `run-as ${appId} sh -c 'cat > files/${file}.next && mv files/${file}.next files/${file}'`,
    ],
    { input: value, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
  );
};
const installed: string[] = [];
let idleChanged = false;
let batteryChanged = false;
let displayChanged = false;
let ownedScreenTimeout: string | undefined;
let invitationId: string | undefined;
let revoked = false;
let controlCompleted = false;
try {
  await until(() => adb("shell", "getprop", "sys.boot_completed") === "1");
  if (!physical && adb("shell", "getprop", "ro.kernel.qemu") !== "1")
    throw new Error("Refusing non-emulator");
  if (!physical) {
    // Boot completion can precede the emulator's DNS service. Warm resolution
    // before the single-use enrollment attempt; ICMP replies are not required.
    await until(() => {
      let output: string;
      try {
        output = adb(
          "shell",
          "ping",
          "-c",
          "1",
          "-W",
          "1",
          new URL(origin).hostname,
        );
      } catch (error) {
        output = String((error as { stdout?: unknown }).stdout ?? "");
      }
      return /^PING [^\n]+\([0-9a-fA-F:.]+\)/m.test(output);
    });
    console.log("Owned emulator DNS ready");
  }
  if (
    control &&
    !physical &&
    existsSync(path.join(state, "control-idle-overrides"))
  ) {
    adb("shell", "dumpsys", "deviceidle", "unforce");
    adb("shell", "dumpsys", "battery", "reset");
    await rm(path.join(state, "control-idle-overrides"));
  }
  if (control && !physical && existsSync(path.join(state, "synthetic-lock"))) {
    await restoreSyntheticLock({ adb, state });
  }
  for (const [pkg, apk] of [
    [appId, "debug/app-debug.apk"],
    [`${appId}.test`, "androidTest/debug/app-debug-androidTest.apk"],
  ] as const) {
    adb(
      "install",
      "--user",
      "0",
      "-r",
      path.join(
        process.env.HOSTED_APK_DIRECTORY ??
          path.join(root, "android/app/build/outputs/apk"),
        apk,
      ),
    );
    installed.push(pkg);
  }
  // Physical mode only installs absent packages and never clears existing data.
  if (!physical) {
    // An interrupted owned fixture must revoke its grants before a data reset
    // destroys the only signing key capable of cleaning up hosted authority.
    adb("shell", "run-as", appId, "mkdir", "-p", "files");
    privateWrite("hosted-stage", "owned-fixture-cleanup");
    const cleanup = adb(
      "shell",
      "am",
      "instrument",
      "-w",
      "-e",
      "class",
      "dev.remoteaccess.app.HostedPairingTest#revokeFixture",
      `${appId}.test/androidx.test.runner.AndroidJUnitRunner`,
    );
    await writeFile(path.join(state, "previous-fixture-cleanup.log"), cleanup, {
      mode: 0o600,
    });
    if (!cleanup.includes("OK (1 test)"))
      throw new Error(
        "Previous owned fixture cleanup failed; preserving authority and keys",
      );
    adb("shell", "pm", "clear", appId);
  }
  if (fcm && !physical)
    adb("shell", "pm", "grant", appId, "android.permission.POST_NOTIFICATIONS");
  adb("shell", "run-as", appId, "mkdir", "-p", "files");
  if (!physical) {
    // Boot/DNS readiness does not imply an unlocked, awake display. Slow CI
    // installs can outlast a fresh emulator's inactivity timeout. Foreground UI
    // acceptance needs an explicit baseline; idle/recovery fixtures sleep later.
    ownedScreenTimeout = adb(
      "shell",
      "settings",
      "get",
      "system",
      "screen_off_timeout",
    );
    adb("shell", "settings", "put", "system", "screen_off_timeout", "1800000");
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    adb("shell", "wm", "dismiss-keyguard");
    await until(() =>
      adb("shell", "dumpsys", "power").includes("mWakefulness=Awake"),
    );
  }
  if (!physical && origin === "https://yepcontrol.com") {
    if (process.env.HOSTED_VERIFY_APP_LINKS !== "0") {
      adb("shell", "pm", "verify-app-links", "--re-verify", appId);
      await until(() =>
        adb("shell", "pm", "get-app-links", appId).includes(
          "yepcontrol.com: verified",
        ),
      );
      await writeFile(
        path.join(state, "app-links.log"),
        adb("shell", "pm", "get-app-links", appId),
        { mode: 0o600 },
      );
      adb(
        "shell",
        "run-as",
        appId,
        "rm",
        "-f",
        "files/hosted-explicit-link-fixture",
      );
    } else {
      privateWrite("hosted-explicit-link-fixture", "owned-emulator-only");
      console.log(
        "OS App Links association excluded for ephemeral CI debug signer; explicit native enrollment and invitation validation still run",
      );
    }
    const links = adb(
      "shell",
      "am",
      "instrument",
      "-w",
      "-e",
      "class",
      "dev.remoteaccess.app.EnrollmentLinkTest",
      `${appId}.test/androidx.test.runner.AndroidJUnitRunner`,
    );
    await writeFile(path.join(state, "enrollment-link.log"), links, {
      mode: 0o600,
    });
    if (!links.includes("OK (6 tests)"))
      throw nativeFailure("Native enrollment link validation failed", links);
  }
  browser = await chromium.launch({ headless: true });
  if (origin === "https://yepcontrol.com") {
    const fallback = await browser.newPage();
    await fallback.goto(`${origin}/enroll#synthetic-install-check`);
    await fallback
      .getByRole("heading", { name: "Get YepControl on your phone" })
      .waitFor();
    if (new URL(fallback.url()).hash)
      throw new Error("Install page retained invitation fragment");
    const play = await fallback
      .getByRole("link", { name: "Install from Google Play" })
      .getAttribute("href");
    if (
      play !==
      "https://play.google.com/store/apps/details?id=com.yepcontrol.app"
    )
      throw new Error("Wrong Play fallback");
    await fallback.close();
  }

  if (control) {
    if (!physical) {
      const storageTests = adb(
        "shell",
        "am",
        "instrument",
        "-w",
        "-e",
        "class",
        "dev.remoteaccess.app.HostStoreTest,dev.remoteaccess.app.UnlockStorageTest,dev.remoteaccess.app.HostedNetworkTest",
        `${appId}.test/androidx.test.runner.AndroidJUnitRunner`,
      );
      await writeFile(path.join(state, "storage-tests.log"), storageTests, {
        mode: 0o600,
      });
      if (
        Number(storageTests.match(/OK \(([0-9]+) tests\)/)?.[1] ?? 0) < 6 ||
        storageTests.includes("FAILURES!!!")
      )
        throw new Error(
          "Native storage/migration tests failed; see private log",
        );
    }
    await controlAcceptance({
      browser,
      origin,
      state,
      adbPath,
      serial,
      adb,
      privateWrite,
      physical: !!physical,
    });
    controlCompleted = true;
  } else if (multi) {
    await mobileAcceptance(
      { browser, origin, state, adbPath, serial, adb, privateWrite },
      pairingOnly,
    );
  } else {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 3,
    });
    await admitProofBrowser(context, origin);
    await candidateViewer(context, origin);
    const page = await context.newPage();
    await page.goto(`${origin}/pair`);
    const qr = page.getByRole("img", { name: "Scan to pair this browser" });
    await qr.waitFor();
    const image = await qr.screenshot({ path: path.join(state, "qr.png") });
    const png = PNG.sync.read(image);
    const decoded = jsQR(
      new Uint8ClampedArray(png.data),
      png.width,
      png.height,
    );
    if (!decoded) throw new Error("Rendered QR did not decode");
    const invitation = decodeInvitation(decoded.data);
    invitationId = invitation.id;
    if (invitation.origin !== origin) throw new Error("Wrong origin in QR");
    privateWrite("hosted-pair-uri", decoded.data);
    async function runNative(label: string) {
      adb(
        "shell",
        "run-as",
        appId,
        "rm",
        "-f",
        "files/hosted-stage",
        "files/hosted-command",
      );
      const logFile = await open(path.join(state, `${label}.log`), "w", 0o600);
      logs.push(logFile);
      instrument = spawn(
        adbPath,
        [
          "-s",
          serial,
          "shell",
          "am",
          "instrument",
          "-w",
          "-e",
          "class",
          "dev.remoteaccess.app.HostedPairingTest#pairOrReconnectAndRevoke",
          `${appId}.test/androidx.test.runner.AndroidJUnitRunner`,
        ],
        { stdio: ["ignore", logFile.fd, logFile.fd] },
      );
      const deadline = Date.now() + 120000;
      let connected = false;
      while (Date.now() < deadline) {
        if (instrument.exitCode !== null)
          throw nativeFailure(
            "Native fixture exited before connection",
            await readFile(path.join(state, `${label}.log`), "utf8"),
          );
        try {
          connected =
            adb("shell", "run-as", appId, "cat", "files/hosted-stage") ===
            "connected";
        } catch {}
        if (connected) break;
        await delay(400);
      }
      if (!connected)
        throw new Error("Native fixture did not connect; see private log");
    }
    async function finishNative(label: string, action: string) {
      privateWrite("hosted-command", action);
      await until(
        () => instrument?.exitCode !== null,
        fcm && action === "wake" ? 150000 : fcm ? 90000 : 30000,
      );
      const nativeLog = await readFile(
        path.join(state, `${label}.log`),
        "utf8",
      );
      if (
        !nativeLog.includes("OK (1 test)") ||
        nativeLog.includes("FAILURES!!!")
      )
        throw nativeFailure("Native acceptance failed", nativeLog);
    }
    let resumePage: string | undefined;
    async function check() {
      if (resumePage) {
        await page.goto(resumePage);
        resumePage = undefined;
      } else await page.reload();
      await page
        .getByRole("status")
        .filter({ hasText: "Ready to connect" })
        .waitFor({ timeout: fcm ? 80000 : 30000 });
    }
    await runNative("pair");
    await check();
    await finishNative("pair", fcm ? "wake" : "finish");
    const readCheckpoints = () => {
      const settings = adb(
        "shell",
        "run-as",
        appId,
        "cat",
        "shared_prefs/paired-browser-v1.xml",
      );
      const timestamp = (key: string) =>
        Number(
          settings.match(
            new RegExp(`<long name="${key}" value="([0-9]+)"`),
          )?.[1] ?? 0,
        );
      return {
        receipt: timestamp("lastPushReceipt"),
        exchange: timestamp("lastWakeExchange"),
      };
    };
    async function wakeCheck() {
      if (migration) {
        resumePage = page.url();
        await page.goto("about:blank");
      }
      // Process reclamation, not force-stop: Firebase must be allowed to restart it.
      await until(() => {
        adb("shell", "am", "kill", "--user", "current", appId);
        // A disconnected ADB target must never count as an absent process.
        return (
          adb(
            "shell",
            `if pidof ${appId} >/dev/null; then echo present; else echo absent; fi`,
          ) === "absent"
        );
      }, 20000);
      if (migration) {
        await writeFile(
          path.join(state, "migration-ready.json"),
          JSON.stringify({ origin, processAbsent: true }),
          { mode: 0o600 },
        );
        console.log(
          "Migration checkpoint ready; waiting for the explicit cutover continuation file",
        );
        await until(
          () => existsSync(path.join(state, "migration-continue")),
          1800000,
        );
      }
      const before = readCheckpoints();
      const clockStart = Date.now();
      const phoneTime = Number(adb("shell", "date", "+%s%3N"));
      const clockEnd = Date.now();
      if (!Number.isSafeInteger(phoneTime) || phoneTime <= 0)
        throw new Error("Invalid device clock");
      const clockOffset = phoneTime - (clockStart + clockEnd) / 2;
      const requestedAt = Date.now() + clockOffset;
      await check();
      const checkpoints = await until(() => {
        const current = readCheckpoints();
        return current.receipt > before.receipt &&
          current.exchange > before.exchange &&
          current.exchange >= current.receipt
          ? current
          : undefined;
      }, 10000);
      if (!checkpoints) throw new Error("Missing fresh native FCM checkpoints");
      return {
        processAbsentBeforeWake: true,
        noApplicationSocketBeforeWake: true,
        firebaseReceived: true,
        nativeEncryptedExchange: true,
        ...(migration ? { pairedBeforeRelayMigration: true } : {}),
        requestToReceiptMs: Math.round(checkpoints.receipt - requestedAt),
        requestToExchangeMs: Math.round(checkpoints.exchange - requestedAt),
        clockEstimateUncertaintyMs: Math.ceil((clockEnd - clockStart) / 2),
      };
    }
    let wakeEvidence = {};
    if (fcm) {
      if (
        adb("shell", "run-as", appId, "cat", "files/hosted-stage") !==
        "wake-ready"
      )
        throw new Error("Native FCM opt-in did not complete");
      wakeEvidence = await wakeCheck();
      console.log("Background FCM wake passed");
    }
    // A fresh Android process and a page reload must retain exact paired identities.
    adb("shell", "am", "force-stop", appId);
    await page.reload();
    await runNative("reconnect");
    await check();
    await finishNative("reconnect", doze ? "wake" : "revoke");
    let dozeEvidence = {};
    if (doze) {
      batteryChanged = true;
      adb("shell", "dumpsys", "battery", "unplug");
      displayChanged = true;
      adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
      idleChanged = true;
      adb("shell", "dumpsys", "deviceidle", "force-idle");
      if (adb("shell", "dumpsys", "deviceidle", "get", "deep") !== "IDLE")
        throw new Error("Phone did not enter deep idle");
      console.log(
        "Deep IDLE verified; allowing push cooldown with no ADB polling",
      );
      await delay(31000);
      if (adb("shell", "dumpsys", "deviceidle", "get", "deep") !== "IDLE")
        throw new Error("Phone left deep idle before wake request");
      const screenOff = /mWakefulness=(Asleep|Dozing)\b/.test(
        adb("shell", "dumpsys", "power"),
      );
      const exempt = adb("shell", "dumpsys", "deviceidle", "whitelist")
        .split("\n")
        .some((line) => line.split(",").includes(appId));
      if (!screenOff || exempt)
        throw new Error(
          "Doze test requires screen off and no host battery exemption",
        );
      dozeEvidence = {
        forcedDeepIdleBeforeWake: true,
        screenOffBeforeWake: true,
        hostBatteryExempt: false,
        dozeWake: await wakeCheck(),
      };
      console.log("Forced-Doze FCM wake passed");
      adb("shell", "dumpsys", "deviceidle", "unforce");
      idleChanged = false;
      adb("shell", "dumpsys", "battery", "reset");
      batteryChanged = false;
      // Cleanup uses the owned fixture's native signing key; no unlock/PIN is needed.
      const result = adb(
        "shell",
        "am",
        "instrument",
        "-w",
        "-e",
        "class",
        "dev.remoteaccess.app.HostedPairingTest#revokeFixture",
        `${appId}.test/androidx.test.runner.AndroidJUnitRunner`,
      );
      if (!result.includes("OK (1 test)"))
        throw new Error("Locked fixture revocation failed");
    }
    const response = await context.request.get(
      `${origin}/api/pair/${invitation.id}`,
    );
    if (response.status() !== 410)
      throw new Error("Revocation not durable at relay");
    revoked = true;
    await page.reload();
    await page
      .getByRole("status")
      .filter({
        hasText:
          /Access to this phone was removed on the phone\.|Phone is unavailable|Connection ended/,
      })
      .waitFor({ timeout: 30000 });
    const report = {
      renderedQrDecoded: true,
      normalGrantUI: true,
      encryptedExchangesAtLeast: doze ? 4 : fcm ? 3 : 2,
      physicalDevice: Boolean(physical),
      ...wakeEvidence,
      ...dozeEvidence,
      persistedAfterAndroidProcessRestart: true,
      persistedAfterBrowserReload: true,
      revoked: true,
      rejectedAfterRevocation: true,
      publicHttpsWss: true,
      androidApi: Number(adb("shell", "getprop", "ro.build.version.sdk")),
    };
    await writeFile(
      path.join(state, "result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report));
  }
} catch (error) {
  if (!physical) {
    try {
      const diagnostic = safeFixtureDiagnostics(
        adb("shell", "run-as", appId, "cat", "files/hosted-failure-state.json"),
      );
      if (diagnostic) console.error("Owned fixture readiness", diagnostic);
    } catch {}
  }
  throw error;
} finally {
  if (invitationId && !revoked)
    console.error(
      physical
        ? "Acceptance did not reach revocation; preserve the physical fixture for cleanup."
        : "Acceptance did not reach revocation; attempting signed owned-fixture cleanup.",
    );
  const cleanupErrors: unknown[] = [];
  async function cleanup(
    label: string,
    action: () => unknown | Promise<unknown>,
  ) {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
      console.error(
        `Cleanup failed: ${label}; preserve private evidence for repair`,
      );
    }
  }
  // Attempt every restoration even if an earlier cleanup operation fails.
  if (idleChanged)
    await cleanup("idle override", () =>
      adb("shell", "dumpsys", "deviceidle", "unforce"),
    );
  if (batteryChanged)
    await cleanup("battery override", () =>
      adb("shell", "dumpsys", "battery", "reset"),
    );
  if (displayChanged)
    await cleanup("display wake", () =>
      adb("shell", "input", "keyevent", "KEYCODE_WAKEUP"),
    );
  if (ownedScreenTimeout !== undefined)
    await cleanup("owned display timeout", () => {
      if (!/^\d+$/.test(ownedScreenTimeout ?? ""))
        adb("shell", "settings", "delete", "system", "screen_off_timeout");
      else
        adb(
          "shell",
          "settings",
          "put",
          "system",
          "screen_off_timeout",
          ownedScreenTimeout as string,
        );
    });
  await cleanup("browser", () => browser?.close());
  if (instrument && instrument.exitCode === null) {
    await cleanup("owned instrumentation", () => {
      try {
        adb("shell", "am", "force-stop", appId);
      } finally {
        instrument?.kill("SIGTERM");
      }
    });
  }
  if (!physical && installed.includes(`${appId}.test`)) {
    await cleanup("owned fixture revocation", async () => {
      if (adb("shell", "getprop", "ro.kernel.qemu") !== "1")
        throw new Error("Refusing cleanup outside the owned emulator");
      privateWrite("hosted-stage", "owned-fixture-cleanup");
      const result = adb(
        "shell",
        "am",
        "instrument",
        "-w",
        "-e",
        "class",
        "dev.remoteaccess.app.HostedPairingTest#revokeFixture",
        `${appId}.test/androidx.test.runner.AndroidJUnitRunner`,
      );
      await writeFile(path.join(state, "fixture-cleanup.log"), result, {
        mode: 0o600,
      });
      if (!result.includes("OK (1 test)"))
        throw nativeFailure("Owned fixture revocation failed", result);
    });
  }
  if (emulator && emulator.exitCode === null) {
    emulator.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => emulator?.once("exit", resolve)),
      delay(10000),
    ]);
    if (emulator.exitCode === null) emulator.kill("SIGKILL");
  }
  for (const handle of logs) await cleanup("native log", () => handle.close());
  await cleanup("emulator log", () => log?.close());
  if (physical && (control ? controlCompleted : !invitationId || revoked)) {
    for (const pkg of installed.reverse())
      await cleanup("owned package", () => {
        adb("uninstall", pkg);
        if (
          !adb("shell", "dumpsys", "package", pkg).includes(
            "Unable to find package",
          )
        )
          throw new Error("Owned test package remains installed");
      });
  }
  if (physical && control && !controlCompleted)
    console.error(
      "Physical control did not finish revocation; preserving owned packages and keys for cleanup.",
    );
  if (physical && previousActivity)
    await cleanup("previous task", () =>
      adb("shell", "am", "start", "--user", "0", "-n", previousActivity),
    );
  if (cleanupErrors.length) process.exitCode = 1;
  if (physical && revoked && !cleanupErrors.length)
    console.log(
      "Owned test packages removed; previous task requested (normal keyguard may remain)",
    );
}

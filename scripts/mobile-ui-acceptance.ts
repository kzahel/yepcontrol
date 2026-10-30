/** Native navigation/appearance and optional storage acceptance. Owns an emulator; needs no relay or physical phone. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, ".local/mobile-ui-proof");
const sdk = process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk");
const adbPath = path.join(sdk, "platform-tools/adb");
const port = 5596;
const serial = `emulator-${port}`;
const app = "com.yepcontrol.app";
const env = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_AVD_HOME: path.join(state, "avd"),
  ANDROID_EMULATOR_HOME: path.join(state, "emulator"),
};
const adb = (...args: string[]) =>
  execFileSync(adbPath, ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: args.includes("instrument") ? 240000 : 20000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function unused(value: number) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(value, "127.0.0.1", () =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
}
assert.ok(
  !execFileSync(adbPath, ["devices"], { encoding: "utf8" }).includes(
    `${serial}\t`,
  ),
  "Refusing an occupied emulator selector",
);
await unused(port);
await unused(port + 1);
await mkdir(env.ANDROID_AVD_HOME, { recursive: true, mode: 0o700 });
await mkdir(env.ANDROID_EMULATOR_HOME, { recursive: true, mode: 0o700 });
await rm(path.join(state, "result.json"), { force: true });
for (const file of await readdir(state)) {
  if (/^ui-[a-z-]+\.png$/.test(file)) await rm(path.join(state, file));
}
const avd = "remote-mobile-ui-api35";
if (!existsSync(path.join(env.ANDROID_AVD_HOME, `${avd}.ini`))) {
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
    { env, input: "no\n", stdio: ["pipe", "pipe", "pipe"], timeout: 60000 },
  );
}
const log = await open(path.join(state, "emulator.log"), "w", 0o600);
const emulator = spawn(
  path.join(sdk, "emulator/emulator"),
  [
    "-avd",
    avd,
    "-port",
    String(port),
    "-no-window",
    "-no-audio",
    "-no-snapshot",
    "-no-boot-anim",
    "-gpu",
    "swiftshader_indirect",
  ],
  { env, stdio: ["ignore", log.fd, log.fd] },
);
try {
  const deadline = Date.now() + 120000;
  let booted = false;
  while (!booted && Date.now() < deadline) {
    if (emulator.exitCode !== null)
      throw new Error("Owned emulator exited; see private log");
    try {
      booted = adb("shell", "getprop", "sys.boot_completed") === "1";
    } catch {}
    if (!booted) await delay(500);
  }
  assert.ok(booted, "Owned emulator did not boot");
  assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1");
  // Match Play's 9:16 screenshot format on this disposable emulator.
  adb("shell", "wm", "size", "1080x1920");
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "wm", "dismiss-keyguard");
  for (const apk of [
    "debug/app-debug.apk",
    "androidTest/debug/app-debug-androidTest.apk",
  ]) {
    adb(
      "install",
      "-r",
      "-t",
      path.join(root, "android/app/build/outputs/apk", apk),
    );
  }
  adb("shell", "pm", "clear", app);
  const result = adb(
    "shell",
    "am",
    "instrument",
    "-w",
    "-e",
    "class",
    "dev.remoteaccess.app.MobileNavigationTest,dev.remoteaccess.app.LocalSettingsProtectionTest",
    `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
  );
  await writeFile(path.join(state, "native.log"), result, { mode: 0o600 });
  for (const file of adb("shell", "run-as", app, "ls", "files").split(/\s+/)) {
    if (!/^ui-[a-z-]+\.png$/.test(file)) continue;
    const png = execFileSync(
      adbPath,
      ["-s", serial, "exec-out", "run-as", app, "cat", `files/${file}`],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
    );
    await writeFile(path.join(state, file), png, { mode: 0o600 });
  }
  assert.match(
    result,
    /OK \(3 tests\)/,
    "Native navigation acceptance failed; see private log/screenshots",
  );
  const storage = process.argv.includes("--storage");
  if (storage) {
    // Independent state from UI tests; no hosted relay, credentials or physical phone.
    adb("shell", "pm", "clear", app);
    const storageResult = adb(
      "shell",
      "am",
      "instrument",
      "-w",
      "-e",
      "class",
      [
        "HostStoreTest",
        "HostDatabaseMigrationTest",
        "UnlockStorageTest",
        "EnrollmentLinkTest",
      ]
        .map((name) => `dev.remoteaccess.app.${name}`)
        .join(","),
      `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
    );
    await writeFile(path.join(state, "storage.log"), storageResult, {
      mode: 0o600,
    });
    assert.match(
      storageResult,
      /OK \(21 tests\)/,
      "Native storage acceptance failed; see private storage.log",
    );
  }
  await writeFile(
    path.join(state, "result.json"),
    JSON.stringify(
      {
        nativeNavigation: true,
        storageAndMigrations: storage,
        drawerAndBack: true,
        fixedTitleBar: true,
        simpleHome: true,
        appearancePersists: true,
        explicitModeOverridesSystem: true,
        followsSystemChanges: true,
        rotationPreservesHierarchy: true,
        screenshotsCaptured: true,
        localSecuritySettings: true,
        remoteInputRejectedOnProtectedScreens: true,
        localSecurityChangesWork: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "Native navigation, appearance, rotation and local-only security settings passed.",
  );
  console.log("Screenshots and receipt: .local/mobile-ui-proof/");
} finally {
  if (emulator.exitCode === null) {
    try {
      adb("emu", "kill");
    } catch {}
    const deadline = Date.now() + 10000;
    while (emulator.exitCode === null && Date.now() < deadline)
      await delay(100);
    if (emulator.exitCode === null) {
      emulator.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        emulator.once("exit", () => resolve()),
      );
    }
  }
  await log.close();
}

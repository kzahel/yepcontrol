/** Normal-package, noninstrumented background/FCM media qualification on an owned emulator. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type WebSocket as BrowserSocket,
  expect,
  type Page,
} from "@playwright/test";
import { mediaBrowserEvidence } from "./media-browser-evidence.js";
import { recordMediaReview } from "./media-review-recording.js";

type Driver = {
  page: Page;
  id: string;
  state: string;
  adbPath: string;
  serial: string;
  adb: (...args: string[]) => string;
  command: (
    action: string,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
  stopNative: () => Promise<void>;
  startNative: () => Promise<void>;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** After owned reboot/local first-unlock and idle FCM recovery, prove retained opt-ins and locked capture. */
export async function hostedMediaAfterRecovery(d: Driver) {
  const { page, adb } = d;
  assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1");
  await d.stopNative();
  assert(
    !/mInstr=ActiveInstrumentation/.test(
      adb("shell", "dumpsys", "activity", "processes"),
    ),
  );
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await delay(15000);
  await page.getByRole("button", { name: "Lock phone", exact: true }).click();
  const locked = () =>
    /KeyguardServiceDelegate[\s\S]*?\bshowing=true/.test(
      adb("shell", "dumpsys", "window", "policy"),
    );
  await expect.poll(locked).toBe(true);
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await page
    .getByLabel("Camera quality", { exact: true })
    .selectOption("still");
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await expect(page.locator(".camera-state")).toHaveAttribute(
    "data-phase",
    "live",
    { timeout: 15000 },
  );
  await expect(page.locator(".microphone-state")).toHaveAttribute(
    "data-phase",
    "live",
    { timeout: 15000 },
  );
  assert(
    locked(),
    "Sensor capture must not dismiss the synthetic secure keyguard",
  );
  const before = await mediaBrowserEvidence(page);
  await expect
    .poll(async () => (await mediaBrowserEvidence(page)).drawn, {
      timeout: 10000,
    })
    .toBeGreaterThan(before.drawn);
  await expect
    .poll(
      async () => {
        const value = await mediaBrowserEvidence(page);
        return (
          value.played > before.played + 5 &&
          value.contexts.includes("running") &&
          value.peak > 0
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Stop camera", exact: true }).click();
  await expect(page.locator(".camera-state")).toHaveAttribute(
    "data-phase",
    "off",
  );
  await expect(page.locator(".microphone-state")).toHaveAttribute(
    "data-phase",
    "live",
  );
  const afterCamera = (await mediaBrowserEvidence(page)).played;
  await expect
    .poll(async () => (await mediaBrowserEvidence(page)).played)
    .toBeGreaterThan(afterCamera + 3);
  await page
    .getByRole("button", { name: "Stop listening", exact: true })
    .click();
  await expect(page.locator(".microphone-state")).toHaveAttribute(
    "data-phase",
    "off",
  );
  await expect
    .poll(() =>
      /isForeground=true[^\n]*foregroundId=10[45]/.test(
        adb("shell", "dumpsys", "activity", "services", "com.yepcontrol.app"),
      ),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Screen", exact: true }).click();
  await page
    .getByRole("button", { name: "Use saved PIN", exact: true })
    .click();
  await expect.poll(locked, { timeout: 15000 }).toBe(false);
  await page
    .getByLabel("Phone PIN", { exact: true })
    .waitFor({ state: "hidden", timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "Lock phone", exact: true }),
  ).toBeEnabled();
  await d.startNative();
  await writeFile(
    path.join(d.state, "media-recovery-result.json"),
    JSON.stringify(
      {
        completed: true,
        afterOwnedRebootAndLocalFirstUnlock: process.env.HOSTED_BOOT === "1",
        lockedCapture: true,
        separateStop: true,
        instrumentedCapture: false,
        before,
        after: await mediaBrowserEvidence(page),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "Reboot/idle recovery retained media settings; explicit locked sensor capture and separate Stop passed",
  );
}
export async function hostedMediaAcceptance(d: Driver) {
  const { page, adb, command } = d;
  assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1");
  const app = "com.yepcontrol.app";
  const checks: unknown[] = [];
  let contacting = 0;
  const socketOpened = (socket: BrowserSocket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        if (JSON.parse(payload).type === "contacting") contacting++;
      } catch {}
    });
  page.on("websocket", socketOpened);
  async function until<T>(work: () => T | Promise<T>, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await work();
      if (value) return value;
      await delay(250);
    }
    throw Error("Hosted media qualification timed out");
  }
  const services = () => adb("shell", "dumpsys", "activity", "services", app);
  const released = () =>
    !/isForeground=true[^\n]*foregroundId=10[45]/.test(services()) &&
    !/\(running\)/.test(adb("shell", "cmd", "appops", "get", app, "CAMERA")) &&
    !/\(running\)/.test(
      adb("shell", "cmd", "appops", "get", app, "RECORD_AUDIO"),
    );
  const receipt = () =>
    Number(
      adb(
        "shell",
        "run-as",
        app,
        "cat",
        "shared_prefs/paired-browser-v1.xml",
      ).match(/<long name="lastPushReceipt" value="([0-9]+)"/)?.[1] ?? 0,
    );
  async function disconnect() {
    const button = page.getByRole("button", {
      name: "Disconnect",
      exact: true,
    });
    if ((await button.isVisible()) && (await button.isEnabled()))
      await button.click();
    else {
      const cancel = page.getByRole("button", {
        name: "Cancel connection",
        exact: true,
      });
      if ((await cancel.isVisible()) && (await cancel.isEnabled()))
        await cancel.click();
    }
    await until(released);
  }
  async function connectViaWake() {
    const before = receipt(),
      beforeContacting = contacting;
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("Ready to connect", {
      timeout: 80000,
    });
    await until(() => receipt() > before, 15000);
    assert(
      contacting > beforeContacting,
      "Relay must report no phone socket before requesting FCM wake",
    );
    await page
      .getByRole("button", { name: "Connect to phone", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Remote screen", exact: true })
      .waitFor({ timeout: 20000 });
    await expect(page.locator(".microphone-state")).toHaveAttribute(
      "data-phase",
      "off",
    );
    assert(released(), "Wake/connect must not start either sensor");
  }
  async function startBoth() {
    await page.getByRole("button", { name: "Camera", exact: true }).click();
    await page
      .getByLabel("Camera quality", { exact: true })
      .selectOption("still");
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await page.getByRole("button", { name: "Listen", exact: true }).click();
  }
  async function usefulMedia() {
    await expect(page.locator(".camera-state")).toHaveAttribute(
      "data-phase",
      "live",
      { timeout: 15000 },
    );
    await expect(page.locator(".microphone-state")).toHaveAttribute(
      "data-phase",
      "live",
      { timeout: 15000 },
    );
    const output = await until(async () => {
      const value = await mediaBrowserEvidence(page);
      return value.drawn >= 2 &&
        value.played >= 5 &&
        value.destinationConnections >= 5 &&
        value.contexts.includes("running") &&
        value.peak > 0
        ? value
        : undefined;
    });
    assert.equal(output.localRequests, 0);
    assert(output.maxAhead <= 0.251);
    assert(/isForeground=true[^\n]*foregroundId=104/.test(services()));
    assert(/isForeground=true[^\n]*foregroundId=105/.test(services()));
    return output;
  }
  const originalServices = adb(
    "shell",
    "settings",
    "get",
    "secure",
    "enabled_accessibility_services",
  );
  let bindingChanged = false;
  const film =
    process.env.MEDIA_REVIEW_RECORDING === "1"
      ? await recordMediaReview(d)
      : undefined;
  const checkpoint = () =>
    writeFile(
      path.join(d.state, "media-result.json"),
      JSON.stringify({ completed: false, checks }, null, 2),
      { mode: 0o600 },
    );
  try {
    await command("media-defaults");
    checks.push("new-or-upgraded-host-both-sensors-default-off");
    film?.chapter(
      "Enable camera and microphone separately; read each disclosure and allow Android permission",
    );
    await command("media-settings");
    await command("automatic", { enabled: true });
    await command("control-ready", { id: d.id });
    await d.stopNative(); // No instrumentation process/privileges during any media start below.
    assert(
      !/mInstr=ActiveInstrumentation/.test(
        adb("shell", "dumpsys", "activity", "processes"),
      ),
    );
    await disconnect();
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await delay(15000); // Exclude the recent-foreground grace window and close ordinary listeners.
    await until(() => !/isForeground=true/.test(services()));
    adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
    await connectViaWake();
    film?.chapter(
      "The paired browser deliberately selects Camera, starts capture and selects Listen",
    );
    await startBoth();
    checks.push({
      check: "socket-absent-FCM-screen-off-bound-service-background-media",
      output: await usefulMedia(),
    });
    if (film) {
      film.chapter(
        "Live encrypted camera and microphone; the phone shows active sharing and Stop",
      );
      adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
      adb("shell", "wm", "dismiss-keyguard");
      adb("shell", "cmd", "statusbar", "expand-notifications");
      await delay(4000);
      adb("shell", "cmd", "statusbar", "collapse");
      film.chapter(
        "Explicit Stop camera and Stop listening release both sensors",
      );
      await page
        .getByRole("button", { name: "Stop camera", exact: true })
        .click();
      await expect(page.locator(".camera-state")).toHaveAttribute(
        "data-phase",
        "off",
      );
      await page
        .getByRole("button", { name: "Stop listening", exact: true })
        .click();
      await expect(page.locator(".microphone-state")).toHaveAttribute(
        "data-phase",
        "off",
      );
      await until(released);
      await delay(2500);
    }
    await checkpoint();
    console.log(
      "Bound-service, socket-absent FCM background camera/audio passed",
    );
    await disconnect();

    await film?.finish();

    // Deliberately remove only this owned emulator's binding. A genuine absent
    // process must precede the push; force-stop is not used for this wake test.
    adb(
      "shell",
      "settings",
      "delete",
      "secure",
      "enabled_accessibility_services",
    );
    bindingChanged = true;
    await delay(1500);
    await until(() => {
      adb("shell", "am", "kill", "--user", "current", app);
      return (
        adb(
          "shell",
          `if pidof ${app} >/dev/null; then echo present; else echo absent; fi`,
        ) === "absent"
      );
    }, 20000);
    await connectViaWake();
    await startBoth();
    await delay(8000);
    const outcome = {
      camera: await page.locator(".camera-state").getAttribute("data-phase"),
      microphone: await page
        .locator(".microphone-state")
        .getAttribute("data-phase"),
      cameraMessage: await page.locator(".camera-state").innerText(),
      microphoneMessage: await page.locator(".microphone-state").innerText(),
    };
    assert.equal(outcome.camera, "off");
    assert.equal(outcome.microphone, "off");
    assert.match(outcome.cameraMessage, /Access was blocked/);
    assert.match(outcome.microphoneMessage, /Access was blocked/);
    checks.push({
      check: "process-absent-real-FCM-without-accessibility-binding",
      outcome,
    });
    await checkpoint();
    console.log("Process-absent FCM without binding:", outcome);
    await page.getByRole("button", { name: "Screen", exact: true }).click();
    await disconnect();
    await until(released);
    adb(
      "shell",
      "settings",
      "put",
      "secure",
      "enabled_accessibility_services",
      originalServices,
    );
    bindingChanged = false;
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    adb("shell", "wm", "dismiss-keyguard");
    await d.startNative();
    await command("control-ready", { id: d.id });
    checks.push("binding-restored-no-automatic-capture");
    assert(released());
    await writeFile(
      path.join(d.state, "media-result.json"),
      JSON.stringify(
        { completed: true, instrumentedCapture: false, checks },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log("Hosted media background/FCM qualification passed");
  } finally {
    try {
      await film?.finish();
    } finally {
      page.off("websocket", socketOpened);
      await disconnect().catch(() => {});
      if (bindingChanged)
        adb(
          "shell",
          "settings",
          "put",
          "secure",
          "enabled_accessibility_services",
          originalServices,
        );
      adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
      adb("shell", "wm", "dismiss-keyguard");
    }
  }
}

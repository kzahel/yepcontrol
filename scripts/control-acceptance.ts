/** Independent browser -> public relay -> native Android effects, on an owned emulator. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, expect } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { resultMessage } from "../protocol/src/control.js";
import { nativeFailure } from "./acceptance-diagnostics.js";
import { candidateViewer } from "./candidate-viewer.js";
import { cliAcceptance } from "./cli-acceptance.js";
import { prepareIdleWake } from "./control-recovery.js";
import { admitProofBrowser } from "./proof-relay.js";

type Fixture = {
  browser: Browser;
  origin: string;
  state: string;
  adbPath: string;
  serial: string;
  adb: (...args: string[]) => string;
  privateWrite: (file: string, value: string) => unknown;
  physical?: boolean;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function controlAcceptance(f: Fixture) {
  const app = "com.yepcontrol.app";
  const { adb, privateWrite } = f;
  if (!f.physical && adb("shell", "getprop", "ro.kernel.qemu") !== "1")
    throw new Error("Control acceptance requires its owned emulator");
  if (
    f.physical &&
    [
      "HOSTED_CLI",
      "HOSTED_UNLOCK",
      "HOSTED_CONTROL_WAKE",
      "HOSTED_BOOT",
      "HOSTED_ROTATION",
    ].some((key) => process.env[key] === "1")
  )
    throw new Error(
      "Physical control excludes credentials, reboot, idle/unlock and forced orientation",
    );
  const log = await open(path.join(f.state, "control-native.log"), "w", 0o600);
  const context = await f.browser.newContext({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 1,
  });
  await admitProofBrowser(context, f.origin);
  await candidateViewer(context, f.origin);
  if (process.env.HOSTED_DIRECT === "1") {
    await context.addInitScript(() => {
      const native = window.RTCPeerConnection;
      const peers: RTCPeerConnection[] = [];
      (window as unknown as { __rtcPeers: RTCPeerConnection[] }).__rtcPeers =
        peers;
      window.RTCPeerConnection = class extends native {
        constructor(config?: RTCConfiguration) {
          super(config);
          peers.push(this);
        }
      };
    });
  } else {
    await context.addInitScript(() => {
      window.RTCPeerConnection = class {
        constructor() {
          throw new Error("Acceptance fixture forces hosted fallback");
        }
      } as unknown as typeof RTCPeerConnection;
    });
  }
  await context.addInitScript(() => {
    const counts = window as unknown as {
      __videoFrames: number;
      __videoBytes: number;
      __stillFrames: number;
    };
    counts.__videoFrames = 0;
    counts.__stillFrames = 0;
    CanvasRenderingContext2D.prototype.drawImage = new Proxy(
      CanvasRenderingContext2D.prototype.drawImage,
      {
        apply(target, self, args) {
          if (
            typeof VideoFrame !== "undefined" &&
            args[0] instanceof VideoFrame
          )
            counts.__videoFrames++;
          if (args[0] instanceof ImageBitmap) counts.__stillFrames++;
          return Reflect.apply(target, self, args);
        },
      },
    );
  });
  const page = await context.newPage();
  let sockets = 0;
  page.on("websocket", () => {
    sockets++;
  });
  let preparationVerified = false;
  const traffic = await context.newCDPSession(page);
  await traffic.send("Network.enable");
  let receivedBytes = 0;
  traffic.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode === 2)
      receivedBytes += Buffer.from(response.payloadData, "base64").length;
  });
  let videoMeasurement:
    | { seconds: number; receivedBytes: number; decodedFrames: number }
    | undefined;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let native: ReturnType<typeof spawn> | undefined;
  let syntheticLock = false;
  let idleWake: Awaited<ReturnType<typeof prepareIdleWake>> | undefined;
  async function until<T>(
    work: () => T | Promise<T>,
    timeout = 60000,
  ): Promise<NonNullable<T>> {
    const patience =
      process.env.CI === "true" ? Math.max(timeout, 20000) : timeout;
    const deadline = Date.now() + patience;
    while (Date.now() < deadline) {
      try {
        const result = await work();
        if (result) return result as NonNullable<T>;
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
      }
      if (native && native.exitCode !== null)
        throw nativeFailure(
          "Native control fixture exited",
          await readFile(path.join(f.state, "control-native.log"), "utf8"),
        );
      await delay(250);
    }
    throw new Error("Control acceptance timed out");
  }
  async function command(action: string, extra: Record<string, unknown> = {}) {
    adb("shell", "run-as", app, "rm", "-f", "files/hosted-stage");
    console.log(`Native step: ${action}`);
    privateWrite("hosted-command", JSON.stringify({ action, ...extra }));
    return until(() => {
      const raw = adb("shell", "run-as", app, "cat", "files/hosted-stage");
      if (action === "stop" && raw === "stopped") return true;
      const value = JSON.parse(raw) as {
        action: string;
        devices: { id: string }[];
      };
      return value.action === action ? value : undefined;
    });
  }
  const witness = () =>
    JSON.parse(
      adb(
        "shell",
        "run-as",
        `${app}.test`,
        "cat",
        "files/control-witness.json",
      ),
    ) as {
      taps: number;
      text: string;
      keyboardShown: boolean;
      fieldFocused: boolean;
      scroll: number;
      target: { x: number; y: number };
      field: { x: number; y: number };
      slider: { x: number; y: number };
      sliderProgress: number;
      sliderHeld: boolean;
      longPresses: number;
      multi: { x: number; y: number };
      maxPointers: number;
      multiMoves: number;
      distanceChange: number;
      angleChange: number;
    };
  async function freshFrames() {
    const count = () =>
      page.evaluate(() => {
        const frames = window as unknown as {
          __videoFrames: number;
          __stillFrames: number;
        };
        return frames.__videoFrames + frames.__stillFrames;
      });
    const before = await count();
    // One capture can already be in flight when the native activity changes.
    // In still mode, subsequent captures also prove held input has drained.
    await until(async () => (await count()) - before >= 2, 20000);
  }
  async function controlFixture() {
    await command("control-fixture", {});
    await freshFrames();
  }
  async function startNative() {
    // --no-restart attaches to a running target (API 35 otherwise dereferences
    // a missing process). This ordinary launch never replaces an active owner.
    adb(
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      `${app}/dev.remoteaccess.app.MainActivity`,
    );
    native = spawn(
      f.adbPath,
      [
        "-s",
        f.serial,
        "shell",
        "am",
        "instrument",
        // Default instrumentation finish force-stops its target, disabling live
        // accessibility/control. Detach/rejoin without changing the tested lifecycle.
        "--no-restart",
        "-w",
        "-e",
        "physicalControl",
        f.physical ? "yes" : "no",
        "-e",
        "class",
        "dev.remoteaccess.app.HostedPairingTest#manageMultipleDevices",
        `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
      ],
      { stdio: ["ignore", log.fd, log.fd] },
    );
    await until(
      () =>
        adb("shell", "run-as", app, "cat", "files/hosted-stage") === "ready",
    );
  }
  async function stopNative() {
    const running = native;
    await command("stop");
    if (running?.exitCode === null)
      await new Promise<void>((resolve) =>
        running.once("exit", () => resolve()),
      );
    native = undefined;
  }
  try {
    await startNative();
    await page.goto(`${f.origin}/pair`);
    await page.bringToFront();
    const qr = PNG.sync.read(
      await page
        .getByRole("img", { name: "Scan to pair this browser" })
        .screenshot(),
    );
    const decoded = jsQR(new Uint8ClampedArray(qr.data), qr.width, qr.height);
    assert.ok(decoded);
    privateWrite("hosted-pair-uri", decoded.data);
    const paired = await command("pair");
    assert.ok(typeof paired !== "boolean");
    const id = paired.devices[0]?.id;
    assert.ok(id);
    if (process.env.HOSTED_CLI === "1") {
      if (f.physical) throw new Error("CLI acceptance owns its emulator only");
      await cliAcceptance({
        origin: f.origin,
        state: f.state,
        page,
        browserId: id,
        adb,
        privateWrite,
        command,
      });
    }
    await command("enable-screen-access");
    if (process.env.HOSTED_UNLOCK === "1") {
      await command("save-fixture-pin");
      await command("allow-unlock", { id, enabled: true });
      // This credential belongs only to the runner's disposable emulator.
      await writeFile(
        path.join(f.state, "synthetic-lock"),
        "owned-emulator-fixture\n",
        { mode: 0o600 },
      );
      const result = adb("shell", "locksettings", "set-pin", "314159");
      assert.match(result, /Pin set/);
      syntheticLock = true;
    }
    if (process.env.HOSTED_CONTROL_WAKE === "1") {
      idleWake = await prepareIdleWake(
        { adb, command, stopNative, startNative, until, state: f.state },
        id,
      );
    } else await command("control-ready", { id });
    if (process.env.HOSTED_PREPARATION === "1") {
      // First exercise a completed readiness check, then continue an in-flight
      // one. Both must use exactly one socket through actual Android promotion.
      await page.reload();
      await expect(page.getByRole("status")).toHaveText("Ready to connect", {
        timeout: 80000,
      });
      const readySockets = sockets;
      const started = Date.now();
      await page.getByRole("button", { name: "Connect to phone" }).click();
      await page
        .getByRole("region", { name: "Remote screen" })
        .waitFor({ timeout: 10000 });
      assert.equal(
        sockets,
        readySockets,
        "Completed check must reuse its socket",
      );
      console.log(
        `Prepared connection promoted in ${Date.now() - started} ms without another socket`,
      );
      await page
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      const before = sockets;
      await page.reload({ waitUntil: "commit" });
      await page.getByRole("button", { name: "Connect to phone" }).click();
      await page
        .getByRole("region", { name: "Remote screen" })
        .waitFor({ timeout: 10000 });
      assert.equal(
        sockets,
        before + 1,
        "Connect during preparation must continue its one socket",
      );
      preparationVerified = true;
      console.log(
        "Native preparation retained and promoted, including Connect during startup",
      );
    } else {
      await page.getByRole("button", { name: "Connect to phone" }).click();
    }
    await page
      .getByRole("region", { name: "Remote screen" })
      .waitFor({ timeout: 80000 });
    if (idleWake) {
      await idleWake.verifyReceipt();
      // Connecting to the locked phone uses its saved PIN automatically.
      await until(
        () =>
          adb("shell", "dumpsys", "window", "policy").match(
            /KeyguardServiceDelegate[\s\S]*?\bshowing=false/,
          ),
        20000,
      );
      await startNative();
      console.log(
        "Real FCM woke idle control; the saved PIN unlocked the synthetic keyguard",
      );
    }
    const canvas = page.getByLabel("Phone screen");
    await until(() =>
      canvas.evaluate((c) => c instanceof HTMLCanvasElement && c.width > 500),
    );
    if (process.env.HOSTED_DIRECT === "1") {
      await until(
        async () =>
          (await page
            .getByRole("region", { name: "Remote screen" })
            .getAttribute("data-transport")) === "direct",
        20000,
      );
      console.log(
        "Fresh pinned-identity session established over native WebRTC",
      );
    }
    if (process.env.HOSTED_UNLOCK === "1") {
      await page
        .getByRole("button", { name: "Lock phone", exact: true })
        .click();
      await page
        .getByLabel("Phone PIN", { exact: true })
        .waitFor({ timeout: 15000 });
      await page
        .getByRole("button", { name: "Use saved PIN", exact: true })
        .click();
      await until(
        () =>
          adb("shell", "dumpsys", "window", "policy").match(
            /KeyguardServiceDelegate[\s\S]*?\bshowing=false/,
          ),
        20000,
      );
      await page
        .getByLabel("Phone PIN", { exact: true })
        .waitFor({ state: "hidden", timeout: 20000 });
      await page
        .getByRole("button", { name: "Lock phone", exact: true })
        .click();
      await page.getByLabel("Phone PIN", { exact: true }).fill("314159");
      await page
        .getByRole("button", { name: "Unlock phone", exact: true })
        .click();
      await until(
        () =>
          adb("shell", "dumpsys", "window", "policy").match(
            /KeyguardServiceDelegate[\s\S]*?\bshowing=false/,
          ),
        20000,
      );
      await page
        .getByLabel("Phone PIN", { exact: true })
        .waitFor({ state: "hidden", timeout: 20000 });
      console.log(
        "Saved and manual PIN unlock passed on the synthetic emulator lock",
      );
    }
    await controlFixture();
    await until(() => witness().taps === 0);
    if (process.env.HOSTED_VIDEO === "1") {
      await page
        .getByRole("switch", { name: "Smooth view", exact: true })
        .click();
      assert.equal(
        await page.getByRole("dialog").count(),
        0,
        "Smooth view opens no browser dialog",
      );
      await command("approve-video");
      // Return from the consent activity to an independent animated native view.
      await controlFixture();
      // Shared runners cold-start software capture and decoding; the subsequent
      // forward-progress measurement keeps its own tighter window.
      await until(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __videoFrames: number }).__videoFrames >
              15,
          ),
        process.env.CI === "true" ? 60000 : 20000,
      );
      console.log(
        `H264 frames decoded over encrypted ${process.env.HOSTED_DIRECT === "1" ? "WebRTC" : "relay"}`,
      );
      const begin = Date.now(),
        bytesBefore = receivedBytes;
      const framesBefore = await page.evaluate(
        () => (window as unknown as { __videoFrames: number }).__videoFrames,
      );
      await delay(5000);
      // Shared CI runners use software capture/encoding. Verify bounded forward
      // progress independently of machine speed, and record the actual duration.
      await until(
        () =>
          page.evaluate(
            (before) =>
              (window as unknown as { __videoFrames: number }).__videoFrames -
                before >=
              10,
            framesBefore,
          ),
        20000,
      );
      videoMeasurement = {
        seconds: (Date.now() - begin) / 1000,
        receivedBytes: receivedBytes - bytesBefore,
        decodedFrames:
          (await page.evaluate(
            () =>
              (window as unknown as { __videoFrames: number }).__videoFrames,
          )) - framesBefore,
      };
      assert.ok(
        videoMeasurement.decodedFrames >= 10,
        "Video must continue decoding during the measurement",
      );
      console.log(`Measured video: ${JSON.stringify(videoMeasurement)}`);
      await expect(
        page.getByRole("switch", { name: "Smooth view", exact: true }),
      ).toBeChecked();
    }
    await delay(1500);
    async function at(p: { x: number; y: number }) {
      await canvas.scrollIntoViewIfNeeded();
      const rect = await canvas.boundingBox();
      assert.ok(rect);
      const size = await canvas.evaluate((c) => ({
        width: (c as HTMLCanvasElement).width,
        height: (c as HTMLCanvasElement).height,
      }));
      return {
        x: rect.x + (p.x * rect.width) / size.width,
        y: rect.y + (p.y * rect.height) / size.height,
      };
    }
    const target = await at(witness().target);
    await page.mouse.click(target.x, target.y);
    await until(() => witness().taps === 1);
    const field = await at(witness().field);
    await delay(800);
    await page.mouse.click(field.x, field.y);
    // The remote click is asynchronous. Wait for the native editor and IME
    // before sending text through the separate browser typing controls.
    await until(() => witness().fieldFocused && witness().keyboardShown);
    await page
      .getByRole("button", { name: "Type or open an app", exact: true })
      .click();
    await page
      .getByLabel("Text for the focused field")
      .fill("Relay 🌞 verified");
    await page.getByRole("button", { name: "Send text" }).click();
    await until(() => witness().text === "Relay 🌞 verified");
    await page.getByRole("button", { name: "Close typing controls" }).click();
    // The fixture's window-insets witness describes the currently visible IME;
    // dumpsys may also include state for earlier input-method clients.
    await delay(1000);
    if (witness().keyboardShown) {
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await until(() => !witness().keyboardShown, 5000);
    }
    await delay(1000);
    assert.match(
      adb("shell", "dumpsys", "activity", "activities"),
      /topResumedActivity=.*ControlFixtureActivity/,
    );
    console.log("Native tap, focused-field text and IME dismissal passed");
    if (
      process.env.HOSTED_SERIAL_VIDEO === "1" &&
      process.env.HOSTED_VIDEO === "1"
    ) {
      const smooth = page.getByRole("switch", {
        name: "Smooth view",
        exact: true,
      });
      const before = await page.evaluate(
        () => (window as unknown as { __stillFrames: number }).__stillFrames,
      );
      await smooth.click();
      await expect(smooth).not.toBeChecked();
      await until(
        () =>
          !adb("shell", "dumpsys", "activity", "services", app).includes(
            "VideoService",
          ),
        20000,
      );
      await until(
        () =>
          page.evaluate(
            (baseline) =>
              (window as unknown as { __stillFrames: number }).__stillFrames -
                baseline >=
              2,
            before,
          ),
        20000,
      );
      console.log("Software video stopped before held-input CI smoke");
    }
    if (process.env.HOSTED_TOUCH === "1") {
      const hold = await at(witness().target);
      await page.mouse.move(hold.x, hold.y);
      await page.mouse.down();
      await until(() => witness().longPresses === 1, 5000);
      await page.mouse.up();
      await delay(1000);
      assert.equal(
        witness().taps,
        1,
        "Long press must not turn into a second tap",
      );
      const slider = witness().slider;
      const begin = await at({ x: 100, y: slider.y }),
        end = await at({ x: 900, y: slider.y });
      await page.mouse.move(begin.x, begin.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 12 });
      await until(
        () => witness().sliderProgress > 650 && witness().sliderHeld,
        5000,
      );
      await page.mouse.up();
      await until(() => !witness().sliderHeld, 3000);
      console.log("Held native slider and long press passed");
      await delay(1000);
      const middle = witness().multi;
      const cdp = await context.newCDPSession(page);
      const points = async (spread: number, angle: number) => {
        const a = await at({
          x: middle.x - spread * Math.cos(angle),
          y: middle.y - spread * Math.sin(angle),
        });
        const b = await at({
          x: middle.x + spread * Math.cos(angle),
          y: middle.y + spread * Math.sin(angle),
        });
        return [
          { id: 1, ...a },
          { id: 2, ...b },
        ];
      };
      try {
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 2,
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: await points(60, 0),
        });
        // Establish the native two-contact baseline before the motion sequence;
        // remote admission and CDP input dispatch complete asynchronously.
        await until(() => witness().maxPointers === 2, 10000);
        for (let n = 1; n <= 12; n++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: await points(60 + n * 8, n * 0.05),
          });
          await delay(60);
        }
        await until(
          () =>
            witness().maxPointers === 2 &&
            witness().multiMoves > 2 &&
            witness().distanceChange > 100 &&
            Math.abs(witness().angleChange) > 0.3,
          5000,
        );
      } catch (error) {
        const { maxPointers, multiMoves, distanceChange, angleChange } =
          witness();
        console.error("Synthetic multi-touch witness", {
          maxPointers,
          multiMoves,
          distanceChange,
          angleChange,
        });
        throw error;
      } finally {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: false,
        });
        await cdp.detach();
      }
      console.log("Two-finger pinch and rotation reached native input");
      await delay(1000);
    }
    const size = await canvas.evaluate((c) => ({
      width: (c as HTMLCanvasElement).width,
      height: (c as HTMLCanvasElement).height,
    }));
    const start = await at({
      x: Math.floor(size.width / 2),
      y: Math.floor(size.height * 0.75),
    });
    const end = await at({
      x: Math.floor(size.width / 2),
      y: Math.floor(size.height * 0.4),
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Playwright's `steps` only interpolates positions; it does not give a
    // gesture a duration. Keep the drag held across multiple native batches,
    // including when a shared CI runner coalesces browser input events.
    await delay(100);
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(
        start.x + ((end.x - start.x) * step) / 8,
        start.y + ((end.y - start.y) * step) / 8,
      );
      await delay(75);
    }
    await page.mouse.up();
    await until(() => witness().scroll > 100);
    await page.screenshot({ path: path.join(f.state, "remote-control.png") });
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await until(
      () =>
        !adb("shell", "dumpsys", "activity", "activities").match(
          /topResumedActivity=.*ControlFixtureActivity/,
        ),
    );
    await page
      .getByRole("button", { name: "Type or open an app", exact: true })
      .click();
    await page.getByRole("button", { name: "Choose an app" }).click();
    await page
      .getByRole("combobox", { name: "Open app" })
      .selectOption("com.android.settings");
    await page.getByRole("button", { name: "Close typing controls" }).click();
    await until(() =>
      adb("shell", "dumpsys", "activity", "activities").match(
        /topResumedActivity=.*com.android.settings/,
      ),
    );
    if (process.env.HOSTED_TOUCH === "1") {
      await controlFixture();
      const slider = await at(witness().slider);
      await page.mouse.move(slider.x, slider.y);
      await page.mouse.down();
      await page.mouse.move(slider.x + 35, slider.y, { steps: 3 });
      await until(() => witness().sliderHeld, 3000);
      const debug = await context.newCDPSession(page);
      await debug.send("Debugger.enable");
      await debug.send("Debugger.pause");
      try {
        await until(() => !witness().sliderHeld, 3000);
      } finally {
        await debug.send("Debugger.resume");
        await debug.detach();
      }
      await page.mouse.up();
      await freshFrames();
      console.log("Native lost-packet watchdog released held input");
    }
    if (process.env.HOSTED_ROTATION === "1") {
      await controlFixture();
      const middle = await at(witness().slider);
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x + 35, middle.y, { steps: 3 });
      await until(() => witness().sliderHeld, 3000);
      try {
        await command("rotate", { landscape: true });
        await until(() => !witness().sliderHeld, 3000);
        await page.mouse.up();
        await until(
          () =>
            canvas.evaluate(
              (c) =>
                (c as HTMLCanvasElement).width >
                (c as HTMLCanvasElement).height,
            ),
          20000,
        );
        const target = await at(witness().target);
        await page.mouse.click(target.x, target.y);
        await until(() => witness().taps === 1);
      } finally {
        await page.mouse.up();
        await command("rotate", { landscape: false });
      }
      await until(
        () =>
          canvas.evaluate(
            (c) =>
              (c as HTMLCanvasElement).width < (c as HTMLCanvasElement).height,
          ),
        20000,
      );
      console.log(
        "Display rotation released held input, resized viewing and preserved touch coordinates",
      );
    }
    if (process.env.HOSTED_DIRECT === "1") {
      await controlFixture();
      const middle = await at(witness().slider);
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x + 35, middle.y, { steps: 3 });
      await until(() => witness().sliderHeld, 3000);
      await page.evaluate(() =>
        (
          window as unknown as { __rtcPeers: RTCPeerConnection[] }
        ).__rtcPeers.forEach((peer) => {
          peer.close();
        }),
      );
      await until(() => !witness().sliderHeld, 3000);
      await page.mouse.up();
      await until(
        async () =>
          (await page
            .getByRole("region", { name: "Remote screen" })
            .getAttribute("data-transport")) === "relay",
        20000,
      );
      console.log(
        "Direct-path loss released native input and recovered through the relay without replay",
      );
    }
    if (process.env.HOSTED_UNLOCK === "1") {
      await page
        .getByRole("button", { name: "Lock phone", exact: true })
        .click();
      await page.getByLabel("Phone PIN", { exact: true }).fill("314158");
      await page
        .getByRole("button", { name: "Unlock phone", exact: true })
        .click();
      await page
        .getByText("Unlock was already attempted.", { exact: false })
        .waitFor({ timeout: 20000 });
      assert.equal(
        await page
          .getByRole("button", { name: "Unlock phone", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Use saved PIN", exact: true })
          .count(),
        0,
      );
      await command("assert-unlock-blocked", { wake: !!idleWake });
      console.log(
        "Wrong synthetic PIN latched local recovery and forgot the saved PIN",
      );
      assert.match(
        adb("shell", "locksettings", "clear", "--old", "314159"),
        /Lock credential cleared/,
      );
      syntheticLock = false;
      await rm(path.join(f.state, "synthetic-lock"), { force: true });
      adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
      adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
      adb("shell", "input", "keyevent", "KEYCODE_BACK");
      adb("shell", "wm", "dismiss-keyguard");
      await until(
        () =>
          adb("shell", "dumpsys", "window", "policy").match(
            /KeyguardServiceDelegate[\s\S]*?\bshowing=false/,
          ),
        10000,
      );
    }
    await command("global", { enabled: false });
    await page
      .getByRole("status")
      .filter({ hasText: /Connection ended/ })
      .waitFor({ timeout: 20000 });
    await page.getByRole("region", { name: "Phone preview" }).waitFor();
    await command("enable", { id, enabled: false });
    await command("remove", { id });
    await command("stop");
    await new Promise<void>((resolve) => {
      if (native?.exitCode !== null) resolve();
      else native.once("exit", () => resolve());
    });
    assert.match(
      await readFile(path.join(f.state, "control-native.log"), "utf8"),
      /OK \(1 test\)/,
    );
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(f.state, "result.json"),
      `${JSON.stringify(
        {
          preparationVerified,
          encryptedScreen: true,
          idleWake: idleWake?.receipt,
          bootRecovery: process.env.HOSTED_BOOT === "1",
          nativeTap: true,
          nativeUnicodeText: true,
          nativeSwipe: true,
          heldTouch: process.env.HOSTED_TOUCH === "1",
          displayRotation: process.env.HOSTED_ROTATION === "1",
          videoMeasurement,
          directAndFallback: process.env.HOSTED_DIRECT === "1",
          smoothVideo: process.env.HOSTED_VIDEO === "1",
          serialVideoInput: process.env.HOSTED_SERIAL_VIDEO === "1",
          savedAndManualPin: process.env.HOSTED_UNLOCK === "1",
          navigation: true,
          appLaunch: true,
          globalDisarmClosesSession: true,
          revoked: true,
          pageErrors: errors,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log("Hosted control effects passed");
  } catch (error) {
    try {
      console.error("Browser video diagnostics", {
        receivedBytes,
        ...(await page.evaluate(() => {
          const counts = window as unknown as {
            __videoFrames: number;
            __stillFrames: number;
          };
          return {
            decodedFrames: counts.__videoFrames,
            stillFrames: counts.__stillFrames,
          };
        })),
      });
    } catch {}
    try {
      const state = witness();
      const messages = await page.getByRole("status").allTextContents();
      console.error("Synthetic native control state", {
        taps: state.taps,
        fieldFocused: state.fieldFocused,
        keyboardShown: state.keyboardShown,
        textLength: state.text.length,
        expectedText: state.text === "Relay 🌞 verified",
        scroll: state.scroll,
        target: state.target,
        longPresses: state.longPresses,
        sliderHeld: state.sliderHeld,
        sliderProgress: state.sliderProgress,
        maxPointers: state.maxPointers,
        multiMoves: state.multiMoves,
        commandResultCodes: Array.from(
          { length: 11 },
          (_, code) => code,
        ).filter((code) => messages.includes(resultMessage(code))),
      });
    } catch {}
    throw error;
  } finally {
    if (native?.exitCode === null && syntheticLock) {
      await command("inspect-lock").catch(() => {});
      try {
        await writeFile(
          path.join(f.state, "lock-hierarchy.xml"),
          adb("shell", "run-as", app, "cat", "files/lock-hierarchy.xml"),
          { mode: 0o600 },
        );
      } catch {}
    }
    if (syntheticLock) {
      try {
        await writeFile(
          path.join(f.state, "service-nodes.txt"),
          adb("shell", "run-as", app, "cat", "files/service-nodes.txt"),
          { mode: 0o600 },
        );
      } catch {}
    }
    await page
      .screenshot({ path: path.join(f.state, "last-browser.png") })
      .catch(() => {});
    try {
      await writeFile(
        path.join(f.state, "last-native.txt"),
        adb("logcat", "-d", "-t", "2500"),
        { mode: 0o600 },
      );
    } catch {}
    try {
      await writeFile(
        path.join(f.state, "last-phone.png"),
        execFileSync(
          f.adbPath,
          ["-s", f.serial, "exec-out", "screencap", "-p"],
          { timeout: 10000, maxBuffer: 10000000 },
        ),
      );
    } catch {}
    await idleWake?.cleanup();
    await traffic.detach().catch(() => {});
    await context.close();
    if (native?.exitCode === null) {
      adb("shell", "am", "force-stop", app);
      native.kill("SIGTERM");
    }
    if (syntheticLock) {
      assert.match(
        adb("shell", "locksettings", "clear", "--old", "314159"),
        /Lock credential cleared/,
      );
      adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
      adb("shell", "wm", "dismiss-keyguard");
      await rm(path.join(f.state, "synthetic-lock"), { force: true });
    }
    await log.close();
  }
}

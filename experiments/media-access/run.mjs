/** Explicit physical-device experiment. No instrumentation or shell sensor grants. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  new URL("../../relay/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const serial = process.env.MEDIA_DEVICE;
const model = process.env.MEDIA_DEVICE_MODEL;
const accessibility = process.env.MEDIA_ACCESSIBILITY === "1";
const teardown = process.env.MEDIA_TEARDOWN ?? "remote-stop";
assert(["remote-stop", "disconnect"].includes(teardown));
const focus = process.env.MEDIA_FOCUS ?? "full";
assert(["full", "cold-screen-off"].includes(focus));
assert(serial && model, "Set MEDIA_DEVICE and MEDIA_DEVICE_MODEL explicitly");
const adapter =
  process.env.ANDROID_DEVICE_CLI ??
  path.resolve(root, "../machine-control/platforms/android/bin/android-device");
const device = (...args) => {
  try {
    return execFileSync(adapter, ["--serial", serial, ...args], {
      encoding: "utf8",
      timeout: 25000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // A protected/locked device is a valid observation, not a failed diagnostic.
    if (args[0] === "doctor" && error.status === 1 && error.stdout) {
      const report = JSON.parse(error.stdout);
      if (report.schema === "machine-control-doctor/v0")
        return error.stdout.trim();
    }
    throw error;
  }
};
const adb = (...args) =>
  execFileSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: 25000,
  }).trim();
const shell = (...args) => device("shell", "--", ...args);
// Settings may rewrite a short ComponentName into its equivalent expanded form.
const accessibilityState = () =>
  shell("settings", "get", "secure", "enabled_accessibility_services")
    .split(":")
    .filter((entry) => entry && entry !== "null")
    .map((entry) => {
      const [name, component] = entry.split("/");
      return component?.startsWith(".") ? `${name}/${name}${component}` : entry;
    })
    .sort()
    .join(":");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Pixels may retain their ambient display after sleep rather than enter Asleep.
// Neither state is interactive; this is distinct from device-idle/Doze testing.
const assertSleeping = (state) =>
  assert(
    ["Asleep", "Dozing"].includes(state),
    "Expected a noninteractive sleeping/ambient-display state",
  );
const pkg = "com.yepcontrol.mediaspike";
const state = path.join(
  root,
  ".local/media-access",
  model.replace(/[^A-Za-z0-9_-]/g, "_"),
);
const token = randomBytes(32).toString("hex");
const results = {
  date: new Date().toISOString(),
  model,
  api: null,
  targetSdk: 36,
  accessibility,
  teardown,
  focus,
  samples: [],
  events: [],
};
let phone;
let browser;
let installed = false;
let reversed = false;
let slept = false;
let previousActivity;
let previousAccessibility;
let page;
let port;
const events = results.events;
const until = async (work, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await work();
    if (value) return value;
    await delay(100);
  }
  throw Error("Media experiment timed out");
};
const markup = `<!doctype html><title>YepControl media experiment</title><canvas></canvas><script>
window.stats = { jpeg: 0, pcm: 0, nonzero: 0, energy: 0, samples: 0, width: 0, height: 0, errors: 0 };
const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
const ws = new WebSocket('ws://' + location.host + '/browser' + location.search);
ws.binaryType = 'arraybuffer';
ws.onmessage = async ({ data }) => {
  const bytes = new Uint8Array(data);
  try {
    if (bytes[0] === 1) {
      const bitmap = await createImageBitmap(new Blob([bytes.subarray(1)], {type:'image/jpeg'}));
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0); bitmap.close();
      stats.jpeg++; stats.width = canvas.width; stats.height = canvas.height;
    } else if (bytes[0] === 2) {
      stats.pcm++;
      const view = new DataView(data, 1);
      for (let i=0; i+1<view.byteLength; i+=2) {
        const value = view.getInt16(i, true);
        stats.samples++; stats.energy += value*value;
        if(value) stats.nonzero++;
      }
    }
  } catch { stats.errors++; }
};
</script>`;
const server = createServer((request, response) => {
  if (request.url !== `/?token=${token}`) {
    response.writeHead(403).end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.setHeader("Cache-Control", "no-store");
  response.end(markup);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
let viewer;
server.on("upgrade", (request, socket, head) => {
  const isPhone =
    request.url === "/phone" &&
    request.headers.authorization === `Bearer ${token}`;
  const isBrowser =
    request.url === `/browser?token=${token}` &&
    request.headers.origin === `http://127.0.0.1:${port}`;
  if (!(isPhone && !phone) && !(isBrowser && !viewer)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (link) => {
    if (isPhone) {
      phone = link;
      link.on("message", (data, binary) => {
        if (binary) {
          if (viewer?.readyState === 1 && viewer.bufferedAmount < 256 * 1024)
            viewer.send(data);
        } else {
          const event = JSON.parse(data.toString());
          events.push({ at: Date.now(), ...event });
          console.log("phone:", event.event, event.detail);
        }
      });
    } else viewer = link;
  });
});
const command = (name) => {
  assert(phone?.readyState === 1);
  phone.send(JSON.stringify({ command: name }));
};
const expectEvent = async (name, operation) => {
  const before = events.length;
  operation();
  return until(() =>
    events.slice(before).find((event) => event.event === name),
  );
};
const launch = (connect = false) =>
  shell(
    "am",
    "start",
    "--user",
    "0",
    "-f",
    "0x24000000",
    "-n",
    `${pkg}/.ProbeActivity`,
    ...(connect ? ["--ei", "port", String(port), "--es", "token", token] : []),
  );
async function clickText(pattern) {
  // A command-driven UI hierarchy; only click a button actually observed on screen.
  shell("uiautomator", "dump", "/data/local/tmp/yep-media-ui.xml");
  const xml = shell("cat", "/data/local/tmp/yep-media-ui.xml");
  shell("rm", "/data/local/tmp/yep-media-ui.xml");
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  const node = nodes.find((entry) => pattern.test(entry));
  if (!node) {
    await writeFile(path.join(state, "last-ui.xml"), xml, { mode: 0o600 });
    return false;
  }
  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert(bounds);
  shell(
    "input",
    "tap",
    String(Math.floor((+bounds[1] + +bounds[3]) / 2)),
    String(Math.floor((+bounds[2] + +bounds[4]) / 2)),
  );
  return true;
}
async function sample(name, milliseconds = 4000) {
  const before = await page.evaluate(() => ({ ...window.stats }));
  await delay(milliseconds);
  const after = await page.evaluate(() => ({ ...window.stats }));
  const result = {
    name,
    milliseconds,
    jpeg: after.jpeg - before.jpeg,
    audioPackets: after.pcm - before.pcm,
    audioSamples: after.samples - before.samples,
    nonzeroSamples: after.nonzero - before.nonzero,
    rms: Math.sqrt(
      (after.energy - before.energy) /
        Math.max(1, after.samples - before.samples),
    ),
    width: after.width,
    height: after.height,
    decodeErrors: after.errors - before.errors,
  };
  results.samples.push(result);
  console.log("sample:", JSON.stringify(result));
  return result;
}
function assertMedia(sample) {
  assert(
    sample.jpeg >= 3 &&
      sample.audioPackets >= 10 &&
      sample.nonzeroSamples > 0 &&
      sample.decodeErrors === 0,
    "Need decoded camera images and real non-silent microphone samples",
  );
}
async function sensorsOn() {
  await expectEvent("camera-started", () => command("camera"));
  await expectEvent("microphone-started", () => command("microphone"));
}
async function sensorsOff() {
  await expectEvent("off", () => command("off"));
  await delay(500);
  const quiet = await sample("sensors-off", 1000);
  assert(quiet.jpeg === 0 && quiet.audioPackets === 0);
}
await mkdir(state, { recursive: true });
try {
  const doctor = JSON.parse(device("doctor", "--json"));
  assert(
    doctor.ready && doctor.extensions?.keyguard?.showing === false,
    "Selected phone must already be awake and locally unlocked",
  );
  assert.equal(shell("getprop", "ro.product.model"), model);
  results.api = shell("getprop", "ro.build.version.sdk");
  assert.equal(shell("am", "get-current-user"), "0");
  previousAccessibility = accessibilityState();
  assert.equal(
    shell("pm", "list", "packages", "--user", "0", pkg),
    "",
    "Refusing to replace an existing experiment app",
  );
  previousActivity = shell("dumpsys", "activity", "activities").match(
    /(?:topResumedActivity|mResumedActivity)[^\n]*? ([\w.]+\/[\w.$]+)/,
  )?.[1];
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  adb("reverse", `tcp:${port}`, `tcp:${port}`);
  reversed = true;
  device(
    "install",
    path.join(
      root,
      "experiments/media-access/android/build/outputs/apk/debug/media-spike-debug.apk",
    ),
  );
  installed = true;
  console.log(
    "Granting normal Android runtime permissions through the phone UI",
  );
  launch();
  await until(() => clickText(/text="Grant camera and microphone"/i), 20000);
  for (let i = 0; i < 5; i++) {
    await delay(300);
    const clicked = await clickText(
      /resource-id="com.android.permissioncontroller:id\/permission_allow_foreground_only_button"|resource-id="com.android.permissioncontroller:id\/permission_allow_button"/,
    );
    if (!clicked) break;
  }
  const permissions = shell("dumpsys", "package", pkg);
  assert(permissions.includes("android.permission.CAMERA: granted=true"));
  assert(permissions.includes("android.permission.RECORD_AUDIO: granted=true"));
  if (Number(results.api) >= 33)
    assert(
      permissions.includes(
        "android.permission.POST_NOTIFICATIONS: granted=true",
      ),
    );
  if (accessibility) {
    console.log(
      "Enabling the experiment's optional accessibility binding through Android Settings",
    );
    shell(
      "am",
      "start",
      "--user",
      "0",
      "-a",
      "android.settings.ACCESSIBILITY_SETTINGS",
    );
    await delay(1000);
    // Settings can restore the previous detail page even for its top-level intent.
    if (!(await clickText(/text="Use YepControl media experiment"/i))) {
      await clickText(/text="Downloaded apps"|text="Installed apps"/i);
      assert(
        await clickText(/text="YepControl media experiment"/i),
        "Expected the experiment in accessibility settings",
      );
      assert(
        await clickText(
          /text="Use YepControl media experiment"|resource-id="com.android.settings:id\/switch_widget"/i,
        ),
        "Expected the observed accessibility switch",
      );
    }
    await delay(500);
    await clickText(/text="Allow"|resource-id="android:id\/button1"/i);
    assert(
      shell("settings", "get", "secure", "enabled_accessibility_services")
        .split(":")
        .some(
          (entry) =>
            entry === `${pkg}/.ProbeAccessService` ||
            entry === `${pkg}/${pkg}.ProbeAccessService`,
        ),
    );
  }
  launch(true);
  console.log("Waiting for the test app's WebSocket connection");
  await until(() => events.find((event) => event.event === "connected"));
  const binding = await expectEvent("status", () => command("status"));
  results.binding = binding.detail;
  if (accessibility)
    assert(
      binding.detail.includes("accessibilityBound=true"),
      "The system must actually bind the accessibility service, not merely list it as enabled",
    );
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
  await until(() => viewer?.readyState === 1);

  // Ordinary background UID, with no shell/instrumentation start of the service.
  shell("input", "keyevent", "KEYCODE_HOME");
  await delay(20000);
  if (focus === "cold-screen-off") {
    shell("input", "keyevent", "KEYCODE_SLEEP");
    slept = true;
    await delay(1000);
    results.coldPower = /mWakefulness=(\w+)/.exec(
      shell("dumpsys", "power"),
    )?.[1];
    results.coldKeyguard = JSON.parse(
      device("doctor", "--json"),
    ).extensions?.keyguard;
    assertSleeping(results.coldPower);
    await delay(500);
  }
  const startIndex = events.length;
  command("arm");
  const cold = await until(() =>
    events
      .slice(startIndex)
      .find((event) => event.event === "error" || event.event === "armed"),
  );
  results.coldBackground = cold;
  if (cold.event === "error") {
    assert(
      /ForegroundServiceStartNotAllowedException|SecurityException/.test(
        cold.detail,
      ),
    );
  } else {
    assert(accessibility, "Unexpected unprivileged cold-background success");
    await sensorsOn();
    assertMedia(
      await sample(
        focus === "cold-screen-off"
          ? "cold-screen-off-accessibility-binding"
          : "cold-background-accessibility-binding",
      ),
    );
    if (focus === "cold-screen-off") {
      results.coldCapturePower = /mWakefulness=(\w+)/.exec(
        shell("dumpsys", "power"),
      )?.[1];
      assertSleeping(results.coldCapturePower);
    }
    await sensorsOff();
    if (focus === "cold-screen-off") {
      await sensorsOn();
      assertMedia(await sample("screen-off-restart-sensors"));
    }
    if (focus === "cold-screen-off" && teardown === "disconnect") {
      phone.close();
      await until(() => phone.readyState === 3);
      await delay(1000);
      const quiet = await sample("after-disconnect", 1000);
      assert(quiet.jpeg === 0 && quiet.audioPackets === 0);
    } else {
      if (focus === "cold-screen-off") await sensorsOff();
      await expectEvent("disarmed", () => command("disarm"));
    }
  }
  if (focus === "full") {
    if (accessibility) {
      // The request is from the socket, not an ADB activity launch. The bound
      // accessibility service shows our visible UI; that UI starts the FGS.
      await expectEvent("armed", () => command("show"));
      await sensorsOn();
      assertMedia(await sample("remote-visible-activity-start"));
      await sensorsOff();
      await expectEvent("disarmed", () => command("disarm"));
    }
    await delay(500);

    launch();
    await delay(1000);
    await expectEvent("armed", () => command("arm"));
    await sensorsOn();
    assertMedia(await sample("foreground"));
    await sensorsOff();

    shell("input", "keyevent", "KEYCODE_HOME");
    await delay(20000);
    assert.equal((await sample("armed-but-idle", 1000)).audioPackets, 0);
    await sensorsOn();
    assertMedia(await sample("background-start-with-armed-service"));
    await sensorsOff();
    await sensorsOn();
    assertMedia(await sample("background-restart-sensors"));

    // Screen timeout/lock is observed without changing lock settings or entering credentials.
    if (process.env.MEDIA_SCREEN_OFF !== "0") {
      shell("input", "keyevent", "KEYCODE_SLEEP");
      slept = true;
      await delay(1000);
      results.screenOffPower = /mWakefulness=(\w+)/.exec(
        shell("dumpsys", "power"),
      )?.[1];
      results.screenOffKeyguard = JSON.parse(
        device("doctor", "--json"),
      ).extensions?.keyguard;
      await delay(500);
      assertMedia(await sample("screen-off"));
      assertSleeping(results.screenOffPower);
      await sensorsOff();
      await sensorsOn();
      assertMedia(await sample("screen-off-restart-sensors"));
    }
    if (teardown === "disconnect") {
      phone.close();
      await until(() => phone.readyState === 3);
      await delay(1000);
      const quiet = await sample("after-disconnect", 1000);
      assert(quiet.jpeg === 0 && quiet.audioPackets === 0);
    } else {
      await sensorsOff();
      await expectEvent("disarmed", () => command("disarm"));
    }
  }
  assert(
    !shell("dumpsys", "activity", "services", pkg).includes(
      "isForeground=true",
    ),
  );
  results.sensorOpsAfterStop = ["CAMERA", "RECORD_AUDIO"].map((op) =>
    shell("cmd", "appops", "get", "--user", "0", pkg, op),
  );
  assert(results.sensorOpsAfterStop.every((op) => !op.includes("(running)")));
  results.completed = true;
} catch (error) {
  results.failure = error.name;
  throw error;
} finally {
  const cleanupErrors = [];
  const clean = async (label, operation) => {
    try {
      return await operation();
    } catch {
      cleanupErrors.push(label);
      return undefined;
    }
  };
  await clean("phone socket", () => phone?.close());
  await clean("Chromium", () => browser?.close());
  for (const link of wss.clients) link.terminate();
  wss.close();
  if (server.listening)
    await clean(
      "local bridge",
      () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
  if (installed) {
    await clean("stop test package", () => device("stop", pkg));
    await clean("uninstall test package", () => adb("uninstall", pkg));
  }
  if (reversed)
    await clean("remove test tunnel", () =>
      adb("reverse", "--remove", `tcp:${port}`),
    );
  if (slept) await clean("wake display", () => device("wake"));
  const status = await clean("observe cleanup", () =>
    JSON.parse(device("doctor", "--json")),
  );
  results.cleanup = {
    errors: cleanupErrors,
    uninstalled: await clean(
      "observe package removal",
      () => !shell("pm", "list", "packages", "--user", "0", pkg),
    ),
    keyguardShowing: status?.extensions?.keyguard?.showing,
    accessibilityPreserved:
      previousAccessibility === undefined ||
      previousAccessibility ===
        (await clean("observe accessibility preservation", () =>
          accessibilityState(),
        )),
  };
  if (status?.extensions?.keyguard?.showing === false && previousActivity)
    await clean("restore prior activity", () =>
      shell("am", "start", "--user", "0", "-n", previousActivity),
    );
  await writeFile(
    path.join(
      state,
      focus === "cold-screen-off"
        ? "result-cold-screen-off.json"
        : accessibility
          ? "result-accessibility.json"
          : "result.json",
    ),
    `${JSON.stringify(results, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert(
    cleanupErrors.length === 0 &&
      results.cleanup.uninstalled &&
      results.cleanup.accessibilityPreserved,
    "Check the private result: experiment cleanup needs attention",
  );
}

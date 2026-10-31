/** Production sensor acceptance. Explicit owned device; no instrumentation or shell permission grants. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import {
  mediaBrowserEvidence,
  observeMediaBrowser,
} from "../../scripts/media-browser-evidence.ts";
import { decodeMedia } from "../../protocol/dist/media.js";
import { cliMediaAcceptance } from "./cli-acceptance.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  new URL("../../relay/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const serial = process.env.MEDIA_DEVICE;
const model = process.env.MEDIA_DEVICE_MODEL;
const firstSensor = process.env.MEDIA_FIRST_SENSOR ?? "camera";
assert(
  serial && model,
  "Select MEDIA_DEVICE and MEDIA_DEVICE_MODEL explicitly",
);
assert(["camera", "microphone"].includes(firstSensor));
const sleepTest = process.env.MEDIA_SCREEN_OFF === "1";
const webUi = process.env.MEDIA_WEB_UI === "1";
const cliMedia = process.env.MEDIA_CLI === "1";
assert(!(webUi && cliMedia), "Choose one UI or CLI acceptance mode");
const encrypted = process.env.MEDIA_ENCRYPTED === "1" || webUi || cliMedia;
const focus = process.env.MEDIA_FOCUS ?? "full";
assert(["full", "permission-loss"].includes(focus));
const adapter =
  process.env.ANDROID_DEVICE_CLI ??
  path.resolve(root, "../machine-control/platforms/android/bin/android-device");
const device = (...args) => {
  try {
    return execFileSync(adapter, ["--serial", serial, ...args], {
      encoding: "utf8",
      timeout: args[0] === "install" ? 180000 : 25000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
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
const accessibility = () =>
  shell("settings", "get", "secure", "enabled_accessibility_services")
    .split(":")
    .filter((v) => v && v !== "null")
    .map((v) => {
      const [pkg, component] = v.split("/");
      return component?.startsWith(".") ? `${pkg}/${pkg}${component}` : v;
    })
    .sort()
    .join(":");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (operation, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await operation();
    if (value) return value;
    await delay(200);
  }
  throw Error("Acceptance timed out");
};
const pkg = "com.yepcontrol.app.mediafixture";
const component = `${pkg}/dev.remoteaccess.app.media.MediaFixtureActivity`;
const token = randomBytes(32).toString("hex");
const stateDir = path.join(
  root,
  `.local/media-access/implementation/${cliMedia ? "phase-5" : webUi ? "phase-4" : encrypted ? "phase-3" : "phase-2"}`,
  model.replace(/[^a-zA-Z0-9_-]/g, "_"),
);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const results = {
  date: new Date().toISOString(),
  model,
  firstSensor,
  sleepTest,
  focus,
  encrypted,
  webUi,
  cliMedia,
  samples: [],
  checks: [],
  events: [],
};
let phone,
  viewer,
  port,
  browser,
  page,
  installed = false,
  installationAttempted = false,
  reversed = false,
  slept = false,
  previousAccessibility,
  previousActivity;
let nextId = 1;
let pairedId;
let invitationId;
let canRemoveFixture = true;
const sequences = new Map();
const counts = new Map();
const replies = [];
const markup = `<!doctype html><title>Production sensor acceptance</title><canvas></canvas><script>
window.stats = {frames:{},audio:{},dimensions:{},errors:0};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
let decoder,stream=0;
const ws=new WebSocket('ws://'+location.host+'/browser'+location.search);ws.binaryType='arraybuffer';
ws.onmessage=async({data})=>{try{
 const b=new Uint8Array(data),v=new DataView(data),kind=b[4],id=v.getUint32(8),w=v.getUint32(24),h=v.getUint32(28),timestamp=Number(v.getBigUint64(16)),body=b.slice(32);
 if(kind===1){const image=await createImageBitmap(new Blob([body],{type:'image/jpeg'}));if(image.width!==w||image.height!==h)throw Error('geometry');canvas.width=w;canvas.height=h;ctx.drawImage(image,0,0);image.close();stats.frames[id]=(stats.frames[id]||0)+1;stats.dimensions[id]=[w,h];}
 if(kind===2){if(stream!==id){decoder?.close();decoder=undefined;stream=id;}
  if(!decoder && b[5]===1){let codec='';for(let i=0;i+7<body.length;i++){if(body[i]===0&&body[i+1]===0&&body[i+2]===1&&(body[i+3]&31)===7){codec='avc1.'+[...body.slice(i+4,i+7)].map(n=>n.toString(16).padStart(2,'0')).join('');break;}}
   if(!codec)throw Error('SPS');const current=id;decoder=new VideoDecoder({output:f=>{try{if(f.displayWidth!==w||f.displayHeight!==h)throw Error('geometry');canvas.width=w;canvas.height=h;ctx.drawImage(f,0,0);stats.frames[current]=(stats.frames[current]||0)+1;stats.dimensions[current]=[w,h];}finally{f.close();}},error:()=>stats.errors++});decoder.configure({codec,optimizeForLatency:true});}
  if(decoder&&decoder.decodeQueueSize<=4)decoder.decode(new EncodedVideoChunk({type:b[5]===1?'key':'delta',timestamp,data:body}));
 }
 if(kind===3){const a=stats.audio[id]??={samples:0,nonzero:0,energy:0};const pcm=new DataView(body.buffer);for(let i=0;i<body.length;i+=2){const n=pcm.getInt16(i,true);a.samples++;a.energy+=n*n;if(n)a.nonzero++;}}
}catch(e){stats.errors++;}};
</script>`;
const server = createServer((req, res) => {
  if (req.url !== `/?token=${token}`) return res.writeHead(403).end();
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  res.end(markup);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });
server.on("upgrade", (req, socket, head) => {
  const isPhone =
    req.url === "/phone" && req.headers.authorization === `Bearer ${token}`;
  const isBrowser =
    req.url === `/browser?token=${token}` &&
    req.headers.origin === `http://127.0.0.1:${port}`;
  if (!(isPhone && !phone) && !(isBrowser && !viewer)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (link) => {
    if (isBrowser) {
      viewer = link;
      return;
    }
    phone = link;
    link.on("close", () => {
      if (phone === link) phone = undefined;
    });
    link.on("message", (data, binary) => {
      if (!binary) {
        replies.push(JSON.parse(data.toString()));
        if (replies.length > 256) replies.shift();
        return;
      }
      const packet = decodeMedia(new Uint8Array(data));
      assert(
        packet.sequence > (sequences.get(packet.stream) ?? 0),
        "Stream sequence must increase",
      );
      sequences.set(packet.stream, packet.sequence);
      const count = counts.get(packet.stream) ?? { jpeg: 0, h264: 0, pcm: 0 };
      if (packet.kind === "event")
        results.events.push({
          stream: packet.stream,
          phase: packet.data[0],
          reason: packet.data[1],
        });
      else count[packet.kind]++;
      counts.set(packet.stream, count);
      assert(results.events.length <= 256);
      if (viewer?.readyState === 1 && viewer.bufferedAmount < 262144)
        viewer.send(data);
    });
  });
});
const send = (command) => {
  assert.equal(phone?.readyState, 1);
  phone.send(JSON.stringify(command));
};
const command = async (op, extra = {}, expected = 0) => {
  const before = replies.length;
  send({ op, ...extra });
  const reply = await until(() =>
    replies
      .slice(before)
      .find(
        (r) => r.op === op && (extra.id === undefined || r.id === extra.id),
      ),
  );
  assert.equal(reply.code, expected, `${op}: unexpected result`);
  return reply;
};
const state = async () => {
  const before = replies.length;
  send({ op: "state" });
  return until(() => replies.slice(before).find((r) => r.op === "state"));
};
const setting = async (camera, value) => {
  const before = replies.length;
  send({ op: "setting", camera, value });
  return until(() => replies.slice(before).find((r) => r.op === "state"));
};
const launch = () =>
  shell(
    "am",
    "start",
    "--user",
    "0",
    "-f",
    "0x24000000",
    "-n",
    component,
    "--ei",
    "port",
    String(port),
    "--es",
    "token",
    token,
  );
async function click(pattern) {
  shell("uiautomator", "dump", "/data/local/tmp/yep-media-host-ui.xml");
  const xml = shell("cat", "/data/local/tmp/yep-media-host-ui.xml");
  shell("rm", "/data/local/tmp/yep-media-host-ui.xml");
  const node = (xml.match(/<node\b[^>]*>/g) ?? []).find((entry) =>
    pattern.test(entry),
  );
  if (!node) {
    await writeFile(path.join(stateDir, "last-ui.xml"), xml, { mode: 0o600 });
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
async function openSettings() {
  shell(
    "am",
    "start",
    "--user",
    "0",
    "-n",
    `${pkg}/dev.remoteaccess.app.MainActivity`,
  );
  await delay(500);
  await until(() =>
    click(new RegExp(`resource-id="${pkg}:id/navigation_menu"`)),
  );
  await until(() => click(/text="Settings"/));
}
async function grant(sensor) {
  console.log("setup", `production ${sensor} setting and runtime permission`);
  await openSettings();
  const resource = sensor === "camera" ? "allow_camera" : "allow_microphone";
  let found = await click(new RegExp(`resource-id="${pkg}:id/${resource}"`));
  if (!found) {
    shell("input", "swipe", "350", "1300", "350", "500", "400");
    found = await click(new RegExp(`resource-id="${pkg}:id/${resource}"`));
  }
  assert(found, "Production sensor setting must be reachable");
  await until(() =>
    click(
      /text="Allow".*resource-id="android:id\/button1"|resource-id="android:id\/button1".*text="Allow"/i,
    ),
  );
  await until(() =>
    click(
      /resource-id="com.android.permissioncontroller:id\/(permission_allow_foreground_only_button|permission_allow_button)"/,
    ),
  );
  await delay(500);
  const status = await state();
  assert(status.media[sensor].allowed && status.media[sensor].permission);
  results.checks.push(`production-${sensor}-disclosure-and-permission`);
}
async function start(sensor, options = {}) {
  const id = nextId++;
  await command(sensor, { id, ...options });
  return id;
}
const terminal = (id) =>
  results.events.find((e) => e.stream === id && e.phase >= 2);
async function stop(id = 0) {
  await command("stop", { id });
  await until(() =>
    [...counts.keys()].every(
      (key) => (id !== 0 && key !== id) || terminal(key),
    ),
  );
  await delay(300);
}
async function sample(name, ids, ms = 3000) {
  await until(() =>
    page.evaluate(
      (ids) =>
        ids.every(
          (id) =>
            (window.stats.frames[id] ?? 0) > 0 ||
            (window.stats.audio[id]?.samples ?? 0) > 0,
        ),
      ids,
    ),
  );
  const before = await page.evaluate(() => structuredClone(window.stats));
  await delay(ms);
  const after = await page.evaluate(() => structuredClone(window.stats));
  const value = {
    name,
    ms,
    frames: {},
    audio: {},
    dimensions: after.dimensions,
    errors: after.errors - before.errors,
  };
  for (const id of ids) {
    value.frames[id] = (after.frames[id] ?? 0) - (before.frames[id] ?? 0);
    const b = before.audio[id] ?? { samples: 0, nonzero: 0, energy: 0 },
      a = after.audio[id] ?? b;
    value.audio[id] = {
      samples: a.samples - b.samples,
      nonzero: a.nonzero - b.nonzero,
      rms: Math.sqrt(
        (a.energy - b.energy) / Math.max(1, a.samples - b.samples),
      ),
    };
  }
  results.samples.push(value);
  console.log("sample", JSON.stringify(value));
  assert.equal(value.errors, 0);
  return value;
}
const assertMedia = (value, camera, mic) => {
  if (camera)
    assert(
      value.frames[camera] >= 2,
      "Need independently decoded camera frames",
    );
  if (mic)
    assert(
      value.audio[mic].samples >= 16000 && value.audio[mic].nonzero > 0,
      "Need non-silent microphone samples",
    );
};
function assertReleased() {
  const records = shell("dumpsys", "activity", "services", pkg).split(
    /\n(?=\s*\* ServiceRecord\{)/,
  );
  assert(
    !records.some(
      (record) =>
        /(?:CameraMediaService|MicrophoneMediaService)/.test(
          record.split("\n")[0] ?? "",
        ) && record.includes("isForeground=true"),
    ),
    "Sensor foreground service remained",
  );
  for (const op of ["CAMERA", "RECORD_AUDIO"])
    assert(
      !shell("cmd", "appops", "get", "--user", "0", pkg, op).includes(
        "(running)",
      ),
      `${op} remained running`,
    );
}
try {
  const doctor = JSON.parse(device("doctor", "--json"));
  assert(
    doctor.ready && doctor.extensions?.keyguard?.showing === false,
    "Selected phone must be unlocked first",
  );
  assert.equal(shell("getprop", "ro.product.model"), model);
  results.api = shell("getprop", "ro.build.version.sdk");
  assert.equal(shell("am", "get-current-user"), "0");
  previousAccessibility = accessibility();
  previousActivity = shell("dumpsys", "activity", "activities").match(
    /(?:topResumedActivity|mResumedActivity)[^\n]*? ([\w.]+\/[\w.$]+)/,
  )?.[1];
  assert.equal(
    shell("pm", "list", "packages", "--user", "0", pkg),
    "",
    "Refusing to replace an existing fixture",
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  adb("reverse", `tcp:${port}`, `tcp:${port}`);
  reversed = true;
  const apk =
    process.env.MEDIA_HOST_APK ??
    path.join(root, "android/app/build/outputs/apk/debug/app-debug.apk");
  const sdk = process.env.ANDROID_HOME;
  assert(sdk, "ANDROID_HOME is required for APK identity preflight");
  const tools = (await readdir(path.join(sdk, "build-tools")))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const badging = execFileSync(
    path.join(sdk, "build-tools", tools.at(-1), "aapt2"),
    ["dump", "badging", apk],
    { encoding: "utf8" },
  );
  assert.equal(
    /package: name='([^']+)'/.exec(badging)?.[1],
    pkg,
    "Refusing to install any APK except the separate fixture package",
  );
  const dex = execFileSync("unzip", ["-p", apk, "classes*.dex"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  assert(
    dex.includes(
      Buffer.from("Ldev/remoteaccess/app/media/MediaFixtureActivity;"),
    ),
    "Fixture class must actually be compiled into the APK",
  );
  installationAttempted = true;
  device("install", apk);
  installed = true;
  assert(
    shell("pm", "list", "packages", "--user", "0", pkg).includes(pkg),
    "Build must use -PmediaFixture=true",
  );
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  if (webUi) await observeMediaBrowser(page);
  if (encrypted) {
    const webRequire = createRequire(
      new URL("../../web/package.json", import.meta.url),
    );
    const { build } = await import(
      pathToFileURL(webRequire.resolve("vite")).href
    );
    const outDir = path.join(stateDir, "browser");
    await build({
      configFile: false,
      logLevel: "error",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        target: "esnext",
        emptyOutDir: false,
        outDir,
        lib: {
          entry: path.join(root, "experiments/media-host/encrypted-client.ts"),
          formats: ["es"],
          fileName: () => "media-proof.js",
          cssFileName: "media-proof",
        },
      },
    });
    const script = await readFile(path.join(outDir, "media-proof.js"));
    const styles = await readFile(path.join(outDir, "media-proof.css"));
    await page.route("https://yepcontrol.com/media-proof/**", (route) =>
      route.fulfill({
        contentType: route.request().url().endsWith(".js")
          ? "application/javascript"
          : route.request().url().endsWith(".css")
            ? "text/css"
            : "text/html",
        body: route.request().url().endsWith(".js")
          ? script
          : route.request().url().endsWith(".css")
            ? styles
            : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Encrypted media acceptance</title><link rel="stylesheet" href="/media-proof/style.css"><script type="module" src="/media-proof/client.js"></script>',
      }),
    );
    await page.goto("https://yepcontrol.com/media-proof/");
    await page.waitForFunction(() => window.mediaProof);
  } else {
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
    await until(() => viewer);
  }
  console.log("setup", "fixture connection");
  launch();
  await until(() => phone);
  const initial = await state();
  assert(!initial.media.camera.allowed && !initial.media.microphone.allowed);
  assert(
    !initial.media.camera.permission && !initial.media.microphone.permission,
  );
  await command("camera", { id: nextId++ }, 11);
  await setting(true, true);
  await command("camera", { id: nextId++ }, 10);
  await setting(true, false);
  results.checks.push("disabled-and-denied-refusals-without-capture");
  for (const sensor of [
    firstSensor,
    firstSensor === "camera" ? "microphone" : "camera",
  ]) {
    await grant(sensor);
    if (Number(results.api) >= 33 && sensor === firstSensor) {
      // A separate explicit notification action; sensor permission does not imply it.
      let found = await click(
        new RegExp(`resource-id="${pkg}:id/media_notifications"`),
      );
      if (!found) {
        shell("input", "swipe", "350", "1300", "350", "500", "400");
        found = await click(
          new RegExp(`resource-id="${pkg}:id/media_notifications"`),
        );
      }
      assert(found, "Sharing notification setup must be reachable");
      await until(() =>
        click(
          /resource-id="com.android.permissioncontroller:id\/permission_allow_button"/,
        ),
      );
    }
    if (!encrypted) {
      const id = await start(sensor, sensor === "camera" ? { fps: 2 } : {});
      const value = await sample(`${sensor}-only`, [id]);
      assertMedia(
        value,
        sensor === "camera" ? id : 0,
        sensor === "microphone" ? id : 0,
      );
      const services = shell("dumpsys", "activity", "services", pkg);
      assert(
        services.includes(
          sensor === "camera" ? "CameraMediaService" : "MicrophoneMediaService",
        ),
      );
      assert(
        !services.includes(
          sensor === "camera" ? "MicrophoneMediaService" : "CameraMediaService",
        ),
      );
      await stop(id);
      assertReleased();
    }
  }
  // Enable the actual production accessibility service by ordinary Android UI.
  shell(
    "am",
    "start",
    "--user",
    "0",
    "-a",
    "android.settings.ACCESSIBILITY_SETTINGS",
  );
  await delay(700);
  if (!(await click(/text="Use YepControl media acceptance"/i))) {
    await click(/text="Downloaded apps"|text="Installed apps"/i);
    await until(() => click(/text="YepControl media acceptance"/i));
    await until(() =>
      click(
        /text="Use YepControl media acceptance"|resource-id="com.android.settings:id\/switch_widget"/i,
      ),
    );
  }
  await delay(400);
  await click(/text="Allow"|resource-id="android:id\/button1"/i);
  await until(async () => (await state()).bound);
  results.checks.push("actual-accessibility-binding");
  await (async () => {
    if (encrypted) {
      if (cliMedia) {
        await cliMediaAcceptance({
          root,
          stateDir,
          page,
          command,
          shell,
          click,
          until,
          delay,
          state,
          assertReleased,
          results,
          setInvitation: (id, paired = false) => {
            invitationId = id;
            canRemoveFixture = false;
            if (paired) pairedId = id;
          },
        });
        return;
      }
      const invitation = await page.evaluate(() => window.mediaProof.invite());
      invitationId = invitation.id;
      canRemoveFixture = false;
      shell(
        "am",
        "start",
        "--user",
        "0",
        "-a",
        "android.intent.action.VIEW",
        "-n",
        `${pkg}/dev.remoteaccess.app.MainActivity`,
        "-d",
        invitation.uri,
      );
      const accepting = page.evaluate(() => window.mediaProof.pair());
      // Attach a rejection handler while native UI consent is in progress.
      void accepting.catch(() => {});
      let consented = false;
      for (let i = 0; i < 6 && !consented; i++) {
        consented = await click(
          new RegExp(`resource-id="${pkg}:id/grant_device"`),
        );
        if (!consented)
          shell("input", "swipe", "350", "1300", "350", "500", "400");
      }
      assert(consented, "Native pairing approval must use the actual UI");
      await accepting;
      pairedId = invitation.id;
      await until(
        async () =>
          (await state()).pairings.some(
            (pair) => pair.id === pairedId && pair.synced,
          ),
        30000,
      );
      results.checks.push("normal-signed-pairing-and-encrypted-native-host");
      for (const direct of [false, true]) {
        await command("connectPaired");
        const connected = await page.evaluate(
          (direct) => window.mediaProof.connect(direct),
          direct,
        );
        assert.equal(connected.media?.v, 1);
        shell("input", "keyevent", "KEYCODE_HOME");
        if (webUi) {
          await page.evaluate(() => window.mediaProof.mountViewer());
          const phase = async (sensor, value) =>
            expect(page.locator(`.${sensor}-state`)).toHaveAttribute(
              "data-phase",
              value,
              { timeout: 15000 },
            );
          await expect(
            page.getByRole("button", { name: "Screen", exact: true }),
          ).toHaveAttribute("aria-pressed", "true");
          await page
            .getByRole("button", { name: "Camera", exact: true })
            .click();
          await phase("camera", "off");
          await page
            .getByRole("button", { name: "Start camera", exact: true })
            .click();
          await phase("camera", "live");
          assert.equal(
            (await page.evaluate(() => window.mediaProof.status())).path,
            direct ? "direct" : "relay",
          );
          await page
            .getByRole("button", { name: "Listen", exact: true })
            .click();
          await phase("microphone", "live");
          await expect
            .poll(async () => (await mediaBrowserEvidence(page)).peak, {
              timeout: 10000,
            })
            .toBeGreaterThan(0);
          const played = await mediaBrowserEvidence(page);
          assert(
            played.played > 0 &&
              played.drawn > 0 &&
              played.contexts.includes("running"),
          );
          assert.equal(played.localRequests, 0);
          results.checks.push({
            check: `real-ui-${direct ? "direct" : "relay"}-h264-and-playback`,
            ...played,
          });
          await setting(true, false);
          await phase("camera", "off");
          await expect(page.locator(".camera-state")).toContainText(
            "turned off",
          );
          await phase("microphone", "live");
          assert(
            !shell(
              "cmd",
              "appops",
              "get",
              "--user",
              "0",
              pkg,
              "CAMERA",
            ).includes("(running)"),
          );
          assert(
            shell(
              "cmd",
              "appops",
              "get",
              "--user",
              "0",
              pkg,
              "RECORD_AUDIO",
            ).includes("(running)"),
          );
          await setting(true, true);
          await page
            .getByRole("button", { name: "Screen", exact: true })
            .click();
          await expect(
            page.getByLabel("Phone screen", { exact: true }),
          ).toBeVisible();
          await phase("microphone", "live");
          await page
            .getByRole("button", { name: "Camera", exact: true })
            .click();
          await phase("camera", "off");
          await page.getByLabel("Camera quality").selectOption("still");
          await page
            .getByLabel("Phone camera", { exact: true })
            .selectOption("front");
          await page
            .getByRole("button", { name: "Start camera", exact: true })
            .click();
          await phase("camera", "live");
          await command("notificationStop");
          await phase("camera", "off");
          await phase("microphone", "off");
          assertReleased();
          await page
            .getByRole("button", { name: "Listen", exact: true })
            .click();
          await phase("microphone", "live");
          await page.evaluate(() =>
            window.mediaBrowserEvidence.contexts.at(-1).suspend(),
          );
          await phase("microphone", "off");
          await expect(page.locator(".microphone-state")).toContainText(
            "playback paused",
          );
          assertReleased();
          results.checks.push(
            `real-ui-${direct ? "direct" : "relay"}-front-jpeg-feature-local-stop-and-playback-suspension`,
          );
          await page
            .getByRole("button", { name: "Start camera", exact: true })
            .click();
          await phase("camera", "live");
          await page
            .getByRole("button", { name: "Listen", exact: true })
            .click();
          await phase("microphone", "live");
          await page.evaluate(
            (direct) =>
              direct
                ? window.mediaProof.dropDirect()
                : window.mediaProof.dropRelay(),
            direct,
          );
          await phase("camera", "off");
          await phase("microphone", "off");
          await delay(1200);
          assertReleased();
          if (direct)
            assert.equal(
              (await page.evaluate(() => window.mediaProof.status())).path,
              "relay",
            );
          results.checks.push(
            `real-ui-${direct ? "direct" : "relay"}-loss-without-sensor-restart`,
          );
          await page.evaluate(() => window.mediaProof.close());
          if (direct) {
            await command("connectPaired");
            await page.evaluate(() => window.mediaProof.connect(true));
            await page.evaluate(() => window.mediaProof.mountViewer());
            await expect(
              page.getByRole("button", { name: "Screen", exact: true }),
            ).toHaveAttribute("aria-pressed", "true");
            assertReleased();
            await page
              .getByRole("button", { name: "Camera", exact: true })
              .click();
            await page
              .getByRole("button", { name: "Start camera", exact: true })
              .click();
            await phase("camera", "live");
            await page
              .getByRole("button", { name: "Listen", exact: true })
              .click();
            await phase("microphone", "live");
            const freeze = await page.context().newCDPSession(page);
            const beforeFreeze = await mediaBrowserEvidence(page);
            let releasedWhileFrozen = false;
            try {
              await freeze.send("Page.setWebLifecycleState", {
                state: "frozen",
              });
              await delay(22500);
              try {
                assertReleased();
                releasedWhileFrozen = true;
              } catch (error) {
                if (error.code !== "ERR_ASSERTION") throw error;
              }
            } finally {
              await freeze.send("Page.setWebLifecycleState", {
                state: "active",
              });
              await freeze.detach();
            }
            const afterFreeze = await mediaBrowserEvidence(page);
            const freezeClock =
              afterFreeze.clockTicks - beforeFreeze.clockTicks;
            const freezeRenewals =
              afterFreeze.renewTicks - beforeFreeze.renewTicks;
            results.checks.push({
              check: "real-ui-freeze-request-timer-witness",
              clockTicks: freezeClock,
              renewTicks: freezeRenewals,
              releasedWhileFrozen,
            });
            if (freezeClock <= 1 && freezeRenewals <= 1)
              assert(
                releasedWhileFrozen,
                "Confirmed timer freeze did not release native sensors",
              );
            await page.evaluate(() => window.mediaProof.close());
            await delay(1200);
            assertReleased();
            await command("connectPaired");
            await page.evaluate(() => window.mediaProof.connect(true));
            await page.evaluate(() => window.mediaProof.mountViewer());
            await expect(
              page.getByRole("button", { name: "Screen", exact: true }),
            ).toHaveAttribute("aria-pressed", "true");
            assertReleased();
            await page
              .getByRole("button", { name: "Camera", exact: true })
              .click();
            await page
              .getByRole("button", { name: "Start camera", exact: true })
              .click();
            await phase("camera", "live");
            await page
              .getByRole("button", { name: "Listen", exact: true })
              .click();
            await phase("microphone", "live");
            const cdp = await page.context().newCDPSession(page);
            try {
              await cdp.send("Debugger.enable");
              const paused = new Promise((resolve) =>
                cdp.once("Debugger.paused", resolve),
              );
              await cdp.send("Debugger.pause");
              await Promise.race([
                paused,
                delay(5000).then(() => {
                  throw Error("JavaScript pause was not confirmed");
                }),
              ]);
              results.checks.push(
                "real-ui-javascript-pause-confirmed-before-release-observation",
              );
              await delay(22500);
              assertReleased();
            } finally {
              await cdp.send("Debugger.resume").catch(() => {});
              await cdp.send("Debugger.disable");
              await cdp.detach();
            }
            await phase("camera", "off");
            await phase("microphone", "off");
            await delay(1000);
            assertReleased();
            results.checks.push(
              "real-ui-confirmed-javascript-pause-releases-native-owner-within-lease-or-transport-bound-and-does-not-restart",
            );
            await page.evaluate(() => window.mediaProof.close());
          }
          await delay(800);
          continue;
        }
        const camera = await page.evaluate(() =>
          window.mediaProof.start("camera", { format: "h264", fps: 15 }),
        );
        assert.equal(
          camera.path,
          direct ? "direct" : "relay",
          "Must qualify the requested real lane",
        );
        const mic = await page.evaluate(() =>
          window.mediaProof.start("microphone"),
        );
        assertMedia(
          await sample(`encrypted-${camera.path}-h264-and-pcm`, [
            camera.stream,
            mic.stream,
          ]),
          camera.stream,
          mic.stream,
        );
        const status = await page.evaluate(() =>
          window.mediaProof.command({ op: "status" }),
        );
        assert.equal(status.state.media.camera.stream, camera.stream);
        assert.equal(status.state.media.microphone.stream, mic.stream);
        const captured = await page.evaluate(() =>
          window.mediaProof.command({ op: "capture" }),
        );
        assert.equal(
          captured.kind,
          "image",
          "Existing screen capture must work while sensors stream",
        );
        const stopAt = Date.now();
        await page.evaluate((id) => window.mediaProof.stop(id), camera.stream);
        results.checks.push({
          check: `encrypted-${camera.path}-camera-stop`,
          milliseconds: Date.now() - stopAt,
        });
        const audioOnly = await sample(
          `encrypted-${camera.path}-camera-off-audio-continues`,
          [camera.stream, mic.stream],
          1500,
        );
        assert.equal(audioOnly.frames[camera.stream], 0);
        assertMedia(audioOnly, 0, mic.stream);
        for (let cycle = 0; cycle < 4; cycle++) {
          const optionalCamera = await page.evaluate(() =>
            window.mediaProof.start("camera", { format: "jpeg", fps: 2 }),
          );
          assertMedia(
            await sample(
              `encrypted-${camera.path}-before-feature-revocation`,
              [optionalCamera.stream, mic.stream],
              1500,
            ),
            optionalCamera.stream,
            mic.stream,
          );
          await setting(true, false);
          await until(async () =>
            (await page.evaluate(() => window.mediaProof.status())).ends.some(
              (end) =>
                end.stream === optionalCamera.stream &&
                end.reason === "disabled",
            ),
          );
          const unaffected = await sample(
            `encrypted-${camera.path}-feature-revocation-audio-continues`,
            [optionalCamera.stream, mic.stream],
            1500,
          );
          assert.equal(unaffected.frames[optionalCamera.stream], 0);
          assertMedia(unaffected, 0, mic.stream);
          await setting(true, true);
          results.checks.push(
            `encrypted-${camera.path}-feature-revocation-with-independent-audio-${cycle + 1}`,
          );
        }
        await page.evaluate((id) => window.mediaProof.pause(id), mic.stream);
        await until(async () =>
          (await page.evaluate(() => window.mediaProof.status())).ends.some(
            (end) => end.stream === mic.stream && end.reason === "interrupted",
          ),
        );
        await delay(500);
        assertReleased();
        results.checks.push(
          `encrypted-${camera.path}-blocked-consumer-stops-native-microphone`,
        );
        const canceled = await page.evaluate(() =>
          window.mediaProof.cancelCamera(),
        );
        assert.equal(canceled.reason, "stopped");
        assert(canceled.connected);
        await delay(300);
        assertReleased();
        results.checks.push(
          `encrypted-${camera.path}-accepted-start-cancellation`,
        );

        const restarted = await page.evaluate(() =>
          window.mediaProof.start("camera", { format: "jpeg", fps: 2 }),
        );
        assertMedia(
          await sample(`encrypted-${camera.path}-jpeg`, [restarted.stream]),
          restarted.stream,
          0,
        );
        if (direct) {
          await page.evaluate(() => window.mediaProof.dropDirect());
          await until(async () => {
            const status = await page.evaluate(() =>
              window.mediaProof.status(),
            );
            return (
              status.path === "relay" &&
              status.ends.some(
                (end) =>
                  end.stream === restarted.stream &&
                  end.reason === "disconnected",
              )
            );
          });
          const recovered = await page.evaluate(() =>
            window.mediaProof.command({ op: "status" }),
          );
          assert.equal(recovered.state.media.camera.phase, "off");
          await delay(500);
          assertReleased();
          results.checks.push(
            "real-direct-loss-relay-recovery-without-media-restart",
          );
          const revokeMic = await page.evaluate(() =>
            window.mediaProof.start("microphone"),
          );
          assertMedia(
            await sample(
              "encrypted-before-client-access-pause",
              [revokeMic.stream],
              1500,
            ),
            0,
            revokeMic.stream,
          );
          await command("clientAccess", { value: false });
          await until(
            async () =>
              !(await page.evaluate(() => window.mediaProof.status()))
                .connected,
          );
          await delay(700);
          assertReleased();
          await command("clientAccess", { value: true });
          await delay(700);
          assertReleased();
          results.checks.push(
            "real-client-access-pause-ends-media-and-does-not-restart-on-enable",
          );
        } else {
          await page.evaluate(() => window.mediaProof.dropRelay());
          await until(
            async () =>
              !(await page.evaluate(() => window.mediaProof.status()))
                .connected,
          );
          await delay(1200);
          assertReleased();
          results.checks.push("real-relay-loss-releases-native-camera");
        }
        await page.evaluate(() => window.mediaProof.close());
        await delay(800);
      }
      return;
    }
    if (focus === "permission-loss") {
      const camera = await start("camera", { fps: 2 });
      const mic = await start("microphone");
      assertMedia(
        await sample("before-runtime-camera-revocation", [camera, mic]),
        camera,
        mic,
      );
      shell(
        "am",
        "start",
        "--user",
        "0",
        "-a",
        "android.settings.APPLICATION_DETAILS_SETTINGS",
        "-d",
        `package:${pkg}`,
      );
      await until(() => click(/text="Permissions"/i));
      await until(() => click(/text="Camera"/i));
      await until(() => click(/text="Don.t allow"/i));
      await delay(500);
      await click(/text="Don.t allow".*resource-id="android:id\/button1"/i);
      await until(() => phone?.readyState !== 1);
      assertReleased();
      const permissions = shell("dumpsys", "package", pkg);
      assert(permissions.includes("android.permission.CAMERA: granted=false"));
      assert(
        permissions.includes("android.permission.RECORD_AUDIO: granted=true"),
      );
      results.permissionLoss = {
        processConnectionEnded: true,
        bothSensorsReleased: true,
        remainingMicrophoneGrant: true,
      };
      launch();
      await until(() => phone?.readyState === 1);
      const restored = await state();
      assert(
        restored.media.camera.allowed && !restored.media.camera.permission,
      );
      assert.equal(restored.media.camera.phase, "off");
      assert.equal(restored.media.microphone.phase, "off");
      await delay(1000);
      assertReleased();
      await command("camera", { id: nextId++ }, 10);
      const restartedMic = await start("microphone");
      assertMedia(
        await sample("explicit-microphone-after-process-recovery", [
          restartedMic,
        ]),
        0,
        restartedMic,
      );
      await stop(restartedMic);
      assertReleased();
      results.checks.push(
        "runtime-permission-loss-process-death-cleanup-and-explicit-recovery",
      );
      return;
    }
    let camera = await start("camera", { facing: 2, fps: 2 });
    let mic = await start("microphone");
    assertMedia(await sample("front-jpeg-and-pcm", [camera, mic]), camera, mic);
    // Exercise the exact production Notification.Action PendingIntent while backgrounded.
    shell("input", "keyevent", "KEYCODE_HOME");
    await delay(1000);
    const notice = await command("notificationStop");
    assert.equal(notice.notifications, 2);
    assert.equal(notice.action, "Stop sharing");
    assert.equal(notice.creator, pkg);
    await until(() => terminal(camera) && terminal(mic));
    assert.equal(terminal(camera).reason, 7);
    assert.equal(terminal(mic).reason, 7);
    await delay(300);
    assertReleased();
    results.checks.push(
      "background-production-notification-pendingintent-stop",
    );
    camera = await start("camera", { format: 2, fps: 15 });
    mic = await start("microphone");
    assertMedia(await sample("rear-h264-and-pcm", [camera, mic]), camera, mic);
    await setting(true, false);
    await until(() => terminal(camera));
    assert.equal(terminal(camera).reason, 2);
    const continued = await sample(
      "camera-disabled-microphone-continues",
      [camera, mic],
      1500,
    );
    assert.equal(continued.frames[camera], 0);
    assertMedia(continued, 0, mic);
    await setting(true, true);
    await stop();
    assertReleased();
    camera = await start("camera", { fps: 2 });
    mic = await start("microphone");
    await command("access", { value: false });
    await until(() => terminal(camera) && terminal(mic));
    assertReleased();
    await command("access", { value: true });
    await delay(300);
    assertReleased();
    results.checks.push("feature-and-owner-revocation-without-restart");
    for (let i = 0; i < 3; i++) {
      const id = await start("camera", { format: (i % 2) + 1 });
      await stop(id);
      assertReleased();
    }
    results.checks.push("late-callback-cancellation");
    mic = await start("microphone");
    await until(() => terminal(mic), 23000);
    assert.equal(terminal(mic).reason, 6);
    assertReleased();
    results.checks.push("lease-expiry");
    shell("input", "keyevent", "KEYCODE_HOME");
    await delay(20000);
    if (sleepTest) {
      shell("input", "keyevent", "KEYCODE_SLEEP");
      slept = true;
      await delay(1800);
      const before = JSON.parse(device("doctor", "--json"));
      results.beforeScreenOffStart = before;
      results.screenOffPower = /mWakefulness=(\w+)/.exec(
        shell("dumpsys", "power"),
      )?.[1];
      assert(
        ["Asleep", "Dozing"].includes(results.screenOffPower),
        "Need noninteractive screen state",
      );
    }
    camera = await start("camera", { format: 2, fps: 15 });
    mic = await start("microphone");
    assertMedia(
      await sample(
        sleepTest ? "fresh-background-screen-off" : "fresh-background",
        [camera, mic],
      ),
      camera,
      mic,
    );
    await stop();
    assertReleased();
    camera = await start("camera", { fps: 2 });
    mic = await start("microphone");
    assertMedia(await sample("background-restart", [camera, mic]), camera, mic);
    phone.close();
    await delay(1500);
    assertReleased();
    results.checks.push("disconnect-releases-native-resources");
  })();
  results.completed = true;
} catch (error) {
  results.failure = `${error.name}: ${error.message}`;
  if (encrypted) {
    results.failureClient = await page
      ?.evaluate(() => window.mediaProof.status())
      .catch(() => undefined);
    results.failureNative = await state().catch(() => undefined);
    results.failureServices = shell("dumpsys", "activity", "services", pkg);
  }
  throw error;
} finally {
  const errors = [];
  const clean = async (name, work) => {
    try {
      return await work();
    } catch {
      errors.push(name);
    }
  };
  if (encrypted && invitationId) {
    await clean("reconcile owned pairing", async () => {
      const response = await fetch(
        `https://yepcontrol.com/api/pair/${invitationId}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (response.status === 410 || response.status === 404) {
        results.pairingRevoked = response.status === 410;
        pairedId = undefined;
        canRemoveFixture = true;
        return;
      }
      assert(response.ok);
      const remote = await response.json();
      if (remote.state === "paired") pairedId = invitationId;
      else {
        assert(
          ["created", "offered"].includes(remote.state),
          "Unknown pairing outcome",
        );
        results.unpairedInvitationExpires = true;
        canRemoveFixture = true; // No durable grant exists; the bounded invitation expires.
      }
    });
  }
  if (encrypted && pairedId && !results.pairingRevoked) {
    await clean("close encrypted session", () =>
      page?.evaluate(() => window.mediaProof.close()),
    );
    await clean("revoke owned pairing", async () => {
      await until(
        async () =>
          (await state()).pairings.some((pair) => pair.id === pairedId),
        15000,
      );
      await command("revokePairings");
      await until(async () => {
        const response = await fetch(
          `https://yepcontrol.com/api/pair/${pairedId}`,
          { signal: AbortSignal.timeout(5000) },
        );
        return response.status === 410;
      }, 30000);
      results.pairingRevoked = true;
      canRemoveFixture = true;
    });
  }
  await clean("phone socket", () => phone?.close());
  await clean("test browser", () => browser?.close());
  for (const link of wss.clients) link.terminate();
  wss.close();
  if (server.listening)
    await clean(
      "bridge",
      () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
  if (installationAttempted && !installed) {
    // A timed-out installer can have committed the APK before losing its reply.
    const present = await clean("reconcile fixture installation", () =>
      shell("pm", "list", "packages", "--user", "0", pkg),
    );
    installed = present?.includes(pkg) === true;
    results.installationReconciled = installed;
    if (!installed) {
      results.installationOutcomeUncertain = true;
      errors.push(
        "fixture installation may still complete; reconcile the exact package before another run",
      );
    }
  }
  if (installed) {
    await clean("stop fixture", () => device("stop", pkg));
    if (canRemoveFixture)
      await clean("remove fixture", () => adb("uninstall", pkg));
    else {
      results.fixtureRetainedForRevocation = true;
      results.pairingReconciliationId = invitationId;
    }
  }
  if (reversed)
    await clean("remove tunnel", () =>
      adb("reverse", "--remove", `tcp:${port}`),
    );
  if (slept) await clean("wake display", () => device("wake"));
  const doctor = await clean("cleanup observation", () =>
    JSON.parse(device("doctor", "--json")),
  );
  results.cleanup = {
    errors,
    keyguardShowing: doctor?.extensions?.keyguard?.showing,
    accessibilityPreserved:
      previousAccessibility === undefined ||
      previousAccessibility ===
        (await clean("accessibility comparison", accessibility)),
  };
  if (doctor?.extensions?.keyguard?.showing === false && previousActivity)
    await clean("restore activity", () =>
      shell("am", "start", "--user", "0", "-n", previousActivity),
    );
  await writeFile(
    path.join(
      stateDir,
      encrypted
        ? "result-encrypted.json"
        : focus === "full"
          ? "result.json"
          : `result-${focus}.json`,
    ),
    `${JSON.stringify(results, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(errors.length, 0, "Cleanup failed");
  assert(results.cleanup.accessibilityPreserved);
}

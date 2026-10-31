/** Production sensor acceptance. Explicit owned device; no instrumentation or shell permission grants. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { decodeMedia } from "../../protocol/dist/media.js";

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
const focus = process.env.MEDIA_FOCUS ?? "full";
assert(["full", "permission-loss"].includes(focus));
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
  ".local/media-access/implementation/phase-2",
  model.replace(/[^a-zA-Z0-9_-]/g, "_"),
);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const results = {
  date: new Date().toISOString(),
  model,
  firstSensor,
  sleepTest,
  focus,
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
  reversed = false,
  slept = false,
  previousAccessibility,
  previousActivity;
let nextId = 1;
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
    ids.every((id) => {
      const value = counts.get(id);
      return value && value.jpeg + value.h264 + value.pcm > 0;
    }),
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
  assert(
    !shell("dumpsys", "activity", "services", pkg).match(
      /(?:CameraMediaService|MicrophoneMediaService)[\s\S]*isForeground=true/,
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
  device("install", apk);
  installed = true;
  assert(
    shell("pm", "list", "packages", "--user", "0", pkg).includes(pkg),
    "Build must use -PmediaFixture=true",
  );
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
  await until(() => viewer);
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
  if (installed) {
    await clean("stop fixture", () => device("stop", pkg));
    await clean("remove fixture", () => adb("uninstall", pkg));
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
      focus === "full" ? "result.json" : `result-${focus}.json`,
    ),
    `${JSON.stringify(results, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(errors.length, 0, "Cleanup failed");
  assert(results.cleanup.accessibilityPreserved);
}

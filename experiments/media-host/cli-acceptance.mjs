/** Real CLI -> production encrypted relay -> selected native fixture. Setup/OS witnesses stay separate. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { decodeInvitation } from "../../protocol/dist/enrollment.js";

export async function cliMediaAcceptance({
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
  setInvitation,
}) {
  const runPath = path.join(stateDir, "cli", `run-${crypto.randomUUID()}`);
  const directory = await realpath(
    await mkdir(runPath, { recursive: true, mode: 0o700 }).then(() => runPath),
  );
  results.cliEvidenceDirectory = directory;
  const home = path.join(directory, "identity"),
    children = [];
  let processNumber = 0;
  function cli(args) {
    const number = ++processNumber;
    const child = spawn(
      process.execPath,
      [path.join(root, "cli/dist/main.js"), ...args, "--json"],
      { cwd: root, env: { ...process.env, YEPCONTROL_HOME: home } },
    );
    children.push(child);
    let stdout = "",
      stderr = "",
      pending = "";
    const messages = [];
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      pending += bytes;
      for (
        let at = pending.indexOf("\n");
        at >= 0;
        at = pending.indexOf("\n")
      ) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        messages.push(JSON.parse(line));
      }
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const done = once(child, "exit").then(async ([code, signal]) => {
      await writeFile(path.join(directory, `process-${number}.jsonl`), stdout, {
        mode: 0o600,
      });
      await writeFile(path.join(directory, `process-${number}.log`), stderr, {
        mode: 0o600,
      });
      return { code, signal, stdout, stderr };
    });
    return { child, messages, done, number };
  }
  async function finish(process, ms = 30000) {
    let timer;
    try {
      return await Promise.race([
        process.done,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`CLI process ${process.number} timed out`)),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function inspect(file, kind) {
    const bytes = await readFile(file);
    assert.equal((await stat(file)).mode & 0o077, 0);
    return page.evaluate(
      async ({ base64, kind }) => {
        const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        if (kind === "jpeg") {
          const image = await createImageBitmap(
            new Blob([data], { type: "image/jpeg" }),
          );
          try {
            return {
              width: image.width,
              height: image.height,
              bytes: data.length,
            };
          } finally {
            image.close();
          }
        }
        const audio = new AudioContext({ sampleRate: 16000 });
        try {
          const decoded = await audio.decodeAudioData(data.buffer),
            samples = decoded.getChannelData(0);
          let energy = 0,
            nonzero = 0;
          for (const sample of samples) {
            energy += sample * sample;
            if (sample) nonzero++;
          }
          return {
            rate: decoded.sampleRate,
            channels: decoded.numberOfChannels,
            samples: samples.length,
            nonzero,
            rms: Math.sqrt(energy / Math.max(1, samples.length)),
          };
        } finally {
          await audio.close();
        }
      },
      { base64: bytes.toString("base64"), kind },
    );
  }
  async function connect() {
    await command("connectPaired");
  }
  try {
    const code = path.join(directory, "pair-code.txt");
    const pairing = cli([
      "pair",
      "--origin",
      "https://yepcontrol.com",
      "--name",
      "CLI media acceptance",
      "--code-file",
      code,
    ]);
    const uri = await until(async () =>
      readFile(code, "utf8").catch(() => undefined),
    );
    const invitation = decodeInvitation(uri.trim());
    setInvitation(invitation.id);
    shell(
      "am",
      "start",
      "--user",
      "0",
      "-a",
      "android.intent.action.VIEW",
      "-n",
      "com.yepcontrol.app.mediafixture/dev.remoteaccess.app.MainActivity",
      "-d",
      uri.trim(),
    );
    let consented = false;
    for (let i = 0; i < 6 && !consented; i++) {
      consented = await click(
        /resource-id="com\.yepcontrol\.app\.mediafixture:id\/grant_device"/,
      );
      if (!consented)
        shell("input", "swipe", "350", "1300", "350", "500", "400");
    }
    assert(consented, "CLI pairing uses the real native approval");
    const paired = await finish(pairing);
    assert.equal(paired.code, 0);
    setInvitation(invitation.id, true);
    await until(
      async () =>
        (await state()).pairings.some(
          (pair) => pair.id === invitation.id && pair.synced,
        ),
      30000,
    );
    results.checks.push("real-cli-normal-signed-pairing");
    shell("input", "keyevent", "KEYCODE_HOME");
    await connect();
    const photo = path.join(directory, "photo.jpg"),
      snapshot = cli([
        "camera",
        "snapshot",
        "--out",
        photo,
        "--facing",
        "rear",
      ]);
    const captured = await finish(snapshot);
    assert.equal(captured.code, 0);
    const image = JSON.parse(captured.stdout);
    assert(
      image.ok &&
        image.latest.path === photo &&
        !Object.hasOwn(image.latest, "scene"),
    );
    assert(
      !captured.stdout.includes('"jpeg":') &&
        !captured.stdout.includes('"data":'),
    );
    const decoded = await inspect(photo, "jpeg");
    assert.equal(decoded.width, image.latest.width);
    assert.equal(decoded.height, image.latest.height);
    assertReleased();
    results.checks.push({
      check: "real-cli-camera-snapshot-decodes",
      ...decoded,
    });
    await connect();
    const frames = path.join(directory, "frames"),
      sampled = await finish(
        cli([
          "camera",
          "frames",
          "--fps",
          "1",
          "--duration",
          "2s",
          "--out-dir",
          frames,
          "--facing",
          "front",
        ]),
      );
    assert.equal(sampled.code, 0);
    const frameResult = JSON.parse(sampled.stdout);
    assert(frameResult.ok && frameResult.count >= 1 && frameResult.count <= 2);
    const manifest = JSON.parse(await readFile(frameResult.manifest, "utf8"));
    for (const frame of manifest.frames) {
      const decoded = await inspect(frame.path, "jpeg");
      assert.equal(decoded.width, frame.width);
      assert.equal(decoded.height, frame.height);
    }
    assert.equal((await stat(frames)).mode & 0o077, 0);
    assertReleased();
    results.checks.push({
      check: "real-cli-sampled-front-frames-decode",
      count: frameResult.count,
    });
    await connect();
    const audio = path.join(directory, "record.wav"),
      recorded = await finish(
        cli(["microphone", "record", "--duration", "1s", "--out", audio]),
      );
    assert.equal(recorded.code, 0);
    const wavResult = JSON.parse(recorded.stdout);
    assert(wavResult.ok && wavResult.latest.samples === 16000);
    const wave = await inspect(audio, "wav");
    assert(
      wave.rate === 16000 &&
        wave.channels === 1 &&
        wave.samples === 16000 &&
        wave.nonzero > 0,
    );
    assertReleased();
    results.checks.push({
      check: "real-cli-wav-independently-decodes",
      ...wave,
    });
    await connect();
    const persistent = cli(["session", "--stdio"]);
    await until(() =>
      persistent.messages.find((message) => message.type === "ready"),
    );
    let id = 0;
    const request = async (operation) => {
      const key = String(++id);
      persistent.child.stdin.write(
        `${JSON.stringify({ id: key, ...operation })}\n`,
      );
      return until(
        () => persistent.messages.find((message) => message.id === key),
        30000,
      );
    };
    const camera = await request({
      op: "cameraStart",
      outDir: path.join(directory, "agent-frames"),
      duration: "10s",
      fps: 1,
    });
    assert(camera.ok);
    const mic = await request({
      op: "microphoneStart",
      out: path.join(directory, "agent-audio.wav"),
      duration: "10s",
    });
    assert(mic.ok);
    const recent = await request({
      op: "mediaReceive",
      stream: mic.reply.stream,
      waitMs: 1000,
      out: path.join(directory, "recent.wav"),
    });
    assert(recent.ok && recent.reply.artifact);
    const sample = await inspect(recent.reply.artifact.path, "wav");
    assert(sample.samples > 0 && sample.samples <= 16000 && sample.nonzero > 0);
    const status = await request({ op: "status" });
    assert(
      status.ok &&
        status.reply.state.media.camera.stream === camera.reply.stream &&
        status.reply.state.media.microphone.stream === mic.reply.stream,
    );
    assert(
      (await request({ op: "mediaStop", stream: camera.reply.stream })).ok,
    );
    const audioContinues = await request({ op: "status" });
    assert.equal(
      audioContinues.reply.state.media.microphone.stream,
      mic.reply.stream,
    );
    assert((await request({ op: "mediaStop", stream: mic.reply.stream })).ok);
    persistent.child.stdin.end();
    assert.equal((await finish(persistent)).code, 0);
    assertReleased();
    results.checks.push({
      check: "real-agent-concurrent-drain-recent-wav-and-independent-stop",
      ...sample,
    });
    // An unread stdout pipe plus explicit client interruption must release active native capture.
    await connect();
    const blocked = cli(["session", "--stdio"]);
    await until(() =>
      blocked.messages.find((message) => message.type === "ready"),
    );
    blocked.child.stdin.write(
      `${JSON.stringify({ id: "mic", op: "microphoneStart", out: path.join(directory, "interrupted.wav"), duration: "60s" })}\n`,
    );
    await until(() =>
      blocked.messages.find((message) => message.id === "mic" && message.ok),
    );
    await delay(500);
    blocked.child.stdout.pause();
    blocked.child.stdin.write(
      Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ id: `capture-${i}`, op: "capture" }),
      ).join("\n") + "\n",
    );
    await delay(1000);
    const stoppedAt = Date.now();
    blocked.child.kill("SIGTERM");
    const interrupted = await finish(blocked, 5000);
    assert.equal(interrupted.code, 1);
    assert.equal(interrupted.signal, null);
    blocked.child.stdout.destroy();
    await delay(700);
    assertReleased();
    results.checks.push({
      check: "real-cli-unread-output-and-sigterm-release",
      milliseconds: Date.now() - stoppedAt,
    });
    assert(
      !(await readdir(directory)).some((name) => name.endsWith(".partial")),
      "No incomplete staging artifact remained",
    );
  } finally {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGTERM");
    await delay(300);
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
  }
}

import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteSession } from "@remote/client/control-session";
import type { Identity } from "@remote/protocol";
import type { Grant } from "@remote/protocol/enrollment";
import { afterEach, expect, it, vi } from "vitest";
import { type NativeCommand, phoneLane } from "../../client/test/phone.js";
import { AgentSession } from "../src/agent-session.js";
import { MediaFile } from "../src/media-artifacts.js";
import { MediaJobs } from "../src/media-jobs.js";

const cleanups: (() => Promise<unknown>)[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jpeg = new Uint8Array([255, 216, 255, 217]); // Framing fixture; physical acceptance independently decodes native JPEG.
const pcm = new Uint8Array(640);
for (let i = 0; i < pcm.length; i += 2) pcm[i] = 1;
it("never replaces a file that appears while an artifact is being captured", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "yep-media-race-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const out = path.join(directory, "photo.jpg"),
    file = await MediaFile.create(out);
  await file.append(jpeg);
  await writeFile(out, "concurrent owner file");
  await expect(file.commit()).rejects.toMatchObject({
    code: "MEDIA_OUTPUT_EXISTS",
  });
  expect(await readFile(out, "utf8")).toBe("concurrent owner file");
  expect(await readdir(directory)).toEqual(["photo.jpg"]);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(
  hook?: (command: NativeCommand) => boolean,
  capable = true,
) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "yep-media-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const parent = new AbortController(),
    phone = phoneLane(capable, hook);
  const { session, state } = await RemoteSession.connect(
    {} as Identity,
    {} as Grant,
    () => {},
    parent.signal,
    { open: async () => phone },
  );
  const jobs = new MediaJobs(session, state, parent.signal);
  cleanups.push(async () => {
    const closing = jobs.close();
    session.close();
    await closing;
  });
  return { directory, parent, phone, session, state, jobs };
}
it("refuses unsupported hosts and unsafe/existing output before sending sensor commands", async () => {
  const old = await setup(undefined, false);
  await expect(
    old.jobs.start({
      kind: "snapshot",
      out: path.join(old.directory, "photo.jpg"),
      facing: "rear",
      fps: 1,
      durationMs: 0,
    }),
  ).rejects.toMatchObject({ code: "MEDIA_UNSUPPORTED" });
  expect(await readdir(old.directory)).toEqual([]);
  expect(old.phone.sent).not.toContain(24);
  const f = await setup();
  const existing = path.join(f.directory, "existing.jpg");
  await writeFile(existing, "keep");
  await expect(
    f.jobs.start({
      kind: "snapshot",
      out: existing,
      facing: "rear",
      fps: 1,
      durationMs: 0,
    }),
  ).rejects.toMatchObject({ code: "MEDIA_OUTPUT_EXISTS" });
  const alias = path.join(f.directory, "alias");
  await symlink(f.directory, alias);
  await expect(
    f.jobs.start({
      kind: "snapshot",
      out: path.join(alias, "photo.jpg"),
      facing: "rear",
      fps: 1,
      durationMs: 0,
    }),
  ).rejects.toMatchObject({ code: "MEDIA_UNSAFE_OUTPUT" });
  expect(await readFile(existing, "utf8")).toBe("keep");
  expect(f.phone.sent).not.toContain(24);
  const unsafe = path.join(f.directory, "shared");
  await mkdir(unsafe);
  await chmod(unsafe, 0o777);
  await expect(
    f.jobs.start({
      kind: "snapshot",
      out: path.join(unsafe, "photo.jpg"),
      facing: "rear",
      fps: 1,
      durationMs: 0,
    }),
  ).rejects.toMatchObject({ code: "MEDIA_UNSAFE_OUTPUT" });
  expect(f.phone.sent).not.toContain(24);
  expect((await f.session.command({ op: "status" })).kind).toBe("state");
});
it("publishes a private snapshot only after receiving it and releases the native owner", async () => {
  const f = await setup(),
    out = path.join(f.directory, "photo.jpg");
  const job = await f.jobs.start({
    kind: "snapshot",
    out,
    facing: "front",
    fps: 1,
    durationMs: 0,
  });
  await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  f.phone.media(job.id, "jpeg", jpeg);
  const result = await job.done;
  expect(result.state).toBe("complete");
  expect(result.latest).toMatchObject({
    path: out,
    kind: "camera",
    format: "jpeg",
    width: 320,
    height: 240,
  });
  expect(await readFile(out)).toEqual(Buffer.from(jpeg));
  expect((await stat(out)).mode & 0o077).toBe(0);
  expect(await readdir(f.directory)).toEqual(["photo.jpg"]);
  expect(f.phone.streams.size).toBe(0);
  expect(f.session.connected).toBe(true);
});
it("drains microphone data without polling, bounds recent samples and finalizes partial WAV on explicit Stop", async () => {
  const f = await setup(),
    out = path.join(f.directory, "record.wav"),
    snippet = path.join(f.directory, "recent.wav");
  const job = await f.jobs.start({ kind: "microphone", out, durationMs: 2000 });
  for (let i = 0; i < 60; i++) {
    f.phone.media(job.id, "pcm", pcm);
    await delay(2);
  }
  await vi.waitFor(() => expect(job.snapshot().samples).toBe(19200));
  const received = await f.jobs.receive(job.id, 0, 0, snippet);
  expect(received.artifact).toMatchObject({
    format: "wav",
    samples: 16000,
    durationMs: 1000,
    startSample: 3200,
  });
  const recent = await readFile(snippet);
  expect(recent.toString("ascii", 0, 4)).toBe("RIFF");
  expect(recent.readUInt32LE(40)).toBe(32000);
  const stopped = await f.jobs.stop(job.id);
  expect(stopped.jobs[0]?.state).toBe("stopped");
  const wave = await readFile(out);
  expect(wave.length).toBe(38444);
  expect(wave.readUInt32LE(4)).toBe(wave.length - 8);
  expect(wave.readUInt32LE(24)).toBe(16000);
  expect(wave.readUInt16LE(22)).toBe(1);
  expect(wave.readUInt16LE(34)).toBe(16);
  expect(wave.readUInt32LE(40)).toBe(38400);
  expect(wave.readInt16LE(44)).toBe(1);
  expect((await stat(out)).mode & 0o077).toBe(0);
  expect(f.phone.streams.size).toBe(0);
  expect((await readdir(f.directory)).sort()).toEqual([
    "recent.wav",
    "record.wav",
  ]);
});
it("keeps agent Stop responsive while an ordinary native reply is pending", async () => {
  let held: NativeCommand | undefined;
  const f = await setup((command) => {
    if (command.op === 3) {
      held = command;
      return true;
    }
    return false;
  });
  const camera = await f.jobs.start({
    kind: "frames",
    out: path.join(f.directory, "frames"),
    facing: "rear",
    fps: 1,
    durationMs: 10000,
  });
  const mic = await f.jobs.start({
    kind: "microphone",
    out: path.join(f.directory, "audio.wav"),
    durationMs: 10000,
  });
  f.phone.media(camera.id, "jpeg", jpeg);
  f.phone.media(mic.id, "pcm", pcm);
  await vi.waitFor(() => expect(camera.snapshot().count).toBe(1));
  const output: Record<string, unknown>[] = [];
  const agent = new AgentSession(
    f.session,
    f.state,
    f.jobs,
    f.parent.signal,
    async (value) => {
      output.push(value as Record<string, unknown>);
    },
    (error) => f.parent.abort(error),
  );
  await agent.accept(JSON.stringify({ id: "blocked", op: "capture" }));
  await f.phone.untilCommand(3);
  await agent.accept(
    JSON.stringify({ id: "stop", op: "mediaStop", stream: 0 }),
  );
  await vi.waitFor(() =>
    expect(output.some((record) => record.id === "stop")).toBe(true),
  );
  expect(output[0]?.id).toBe("stop");
  expect(f.phone.streams.size).toBe(0);
  f.phone.reply(held?.id ?? 0);
  await agent.finish();
  expect(output.map((record) => record.id)).toEqual(["stop", "blocked"]);
  const manifest = JSON.parse(
    await readFile(path.join(f.directory, "frames/capture.json"), "utf8"),
  );
  expect(manifest.partial).toBe(true);
  expect(manifest.frames).toHaveLength(1);
  expect((await stat(path.join(f.directory, "frames"))).mode & 0o077).toBe(0);
});
it("Stop all cancels earlier queued starts without preventing a later explicit start", async () => {
  let held: NativeCommand | undefined;
  const f = await setup((command) => {
    if (command.op === 3) {
      held = command;
      return true;
    }
    return false;
  });
  const output: Record<string, unknown>[] = [];
  const agent = new AgentSession(
    f.session,
    f.state,
    f.jobs,
    f.parent.signal,
    async (value) => {
      output.push(value as Record<string, unknown>);
    },
    (error) => f.parent.abort(error),
  );
  await agent.accept(JSON.stringify({ id: "blocked", op: "capture" }));
  await f.phone.untilCommand(3);
  await agent.accept(
    JSON.stringify({
      id: "before-stop",
      op: "cameraStart",
      outDir: path.join(f.directory, "before"),
      duration: "1s",
    }),
  );
  await agent.accept(
    JSON.stringify({ id: "stop-all", op: "mediaStop", stream: 0 }),
  );
  await vi.waitFor(() =>
    expect(output.some((r) => r.id === "stop-all")).toBe(true),
  );
  await agent.accept(
    JSON.stringify({
      id: "after-stop",
      op: "microphoneStart",
      out: path.join(f.directory, "after.wav"),
      duration: "1s",
    }),
  );
  f.phone.reply(held?.id ?? 0);
  await vi.waitFor(() =>
    expect(output.some((r) => r.id === "after-stop")).toBe(true),
  );
  expect(output.find((r) => r.id === "before-stop")).toMatchObject({
    ok: false,
    errorCode: "MEDIA_CANCELED",
  });
  expect(f.phone.sent).not.toContain(24);
  expect(f.phone.sent).toContain(25);
  await agent.finish();
  expect(await readdir(f.directory)).toEqual([]);
});
it("closed input prevents a queued media start from opening a sensor", async () => {
  let held: NativeCommand | undefined;
  const f = await setup((command) => {
    if (command.op === 3) {
      held = command;
      return true;
    }
    return false;
  });
  const output: Record<string, unknown>[] = [];
  const agent = new AgentSession(
    f.session,
    f.state,
    f.jobs,
    f.parent.signal,
    async (value) => {
      output.push(value as Record<string, unknown>);
    },
    (error) => f.parent.abort(error),
  );
  await agent.accept(JSON.stringify({ id: "first", op: "capture" }));
  await f.phone.untilCommand(3);
  await agent.accept(
    JSON.stringify({
      id: "late",
      op: "cameraStart",
      outDir: path.join(f.directory, "frames"),
      duration: "1s",
    }),
  );
  const finishing = agent.finish();
  f.phone.reply(held?.id ?? 0);
  await finishing;
  expect(output.find((record) => record.id === "late")).toMatchObject({
    ok: false,
    errorCode: "MEDIA_CANCELED",
  });
  expect(f.phone.sent).not.toContain(24);
  expect(await readdir(f.directory)).toEqual([]);
});
it("parent cancellation closes capture and leaves only a valid private partial recording", async () => {
  const f = await setup(),
    out = path.join(f.directory, "partial.wav");
  const job = await f.jobs.start({
    kind: "microphone",
    out,
    durationMs: 10000,
  });
  f.phone.media(job.id, "pcm", pcm);
  await vi.waitFor(() => expect(job.snapshot().samples).toBe(320));
  f.parent.abort();
  const result = await job.done;
  expect(result.state).toBe("canceled");
  expect(result.error?.code).toBe("MEDIA_CANCELED");
  expect(f.phone.streams.size).toBe(0);
  const wave = await readFile(out);
  expect(wave.length).toBe(684);
  expect(wave.readUInt32LE(40)).toBe(640);
  expect(await readdir(f.directory)).toEqual(["partial.wav"]);
});

it("does not report Stop success when its ACK never gets a native release event", async () => {
  let phone: ReturnType<typeof phoneLane> | undefined;
  const f = await setup((command) => {
    if (command.op !== 26) return false;
    phone?.reply(command.id);
    return true;
  });
  phone = f.phone;
  const job = await f.jobs.start({
    kind: "microphone",
    out: path.join(f.directory, "uncertain.wav"),
    durationMs: 10000,
  });
  f.phone.media(job.id, "pcm", pcm);
  await vi.waitFor(() => expect(job.snapshot().samples).toBe(320));
  const stopped = await f.jobs.stop(job.id);
  expect(stopped.stopped).toBe(false);
  expect(stopped.jobs[0]).toMatchObject({
    state: "error",
    stopConfirmed: false,
  });
  expect(f.session.connected).toBe(false);
  expect(f.phone.streams.size).toBe(0);
}, 12000);

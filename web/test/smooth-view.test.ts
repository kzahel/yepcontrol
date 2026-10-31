import type { Command, Reply, VideoState } from "@remote/protocol/control";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmoothView } from "../src/smooth-view.js";

let host: VideoState;
let commands: Command[];
let start: (() => Promise<void>) | undefined;
let stopError = false;
let controller: SmoothView;
let reset: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  commands = [];
  host = { id: 0, phase: "off", reason: "none" };
  start = undefined;
  stopError = false;
  reset = vi.fn<() => void>();
  controller = new SmoothView(
    {
      connected: true,
      async command(command): Promise<Reply> {
        commands.push(command);
        if (command.op === "video") {
          if (command.quality) {
            await start?.();
            host = { id: host.id + 1, phase: "consent", reason: "none" };
          } else {
            if (stopError) throw Error("Connection lost");
            host = { ...host, phase: "off", reason: "stopped" };
          }
          return { id: 1, kind: "result", code: 0 };
        }
        return { id: 1, kind: "state", state: { video: { ...host } } } as Reply;
      },
    },
    vi.fn(),
    reset,
  );
});
afterEach(() => {
  controller.close();
  vi.useRealTimers();
});
const video = () => commands.filter((c) => c.op === "video");
const settled = () =>
  vi.waitFor(() =>
    expect(controller.state.message).toContain("Approve screen sharing"),
  );

it("waits for an in-flight screen start to be stopped before a source handoff", async () => {
  let release = () => {};
  start = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  controller.setEnabled(true);
  const stopped = controller.stop();
  expect(video()).toEqual([{ op: "video", quality: 2 }]);
  release();
  await stopped;
  expect(video()).toEqual([
    { op: "video", quality: 2 },
    { op: "video", quality: 0 },
  ]);
  expect(controller.state).toMatchObject({
    wanted: false,
    phase: "off",
    message: "",
  });
});

it("rejects an unconfirmed screen stop so the source owner can close its connection", async () => {
  controller.setEnabled(true);
  await settled();
  stopError = true;
  await expect(controller.stop()).rejects.toThrow("confirm");
});

it("coalesces clicks while preserving Off before a new On", async () => {
  let release = () => {};
  start = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  controller.setEnabled(true);
  controller.setEnabled(false);
  controller.setEnabled(true);
  expect(video()).toEqual([{ op: "video", quality: 2 }]);
  start = undefined;
  release();
  await settled();
  expect(video()).toEqual([
    { op: "video", quality: 2 },
    { op: "video", quality: 0 },
    { op: "video", quality: 2 },
  ]);
});

it("waits for an actually displayed frame, and stops accepting video immediately on Off", async () => {
  controller.setEnabled(true);
  await settled();
  controller.observe({ id: 1, phase: "starting", reason: "none" });
  expect(controller.state.phase).toBe("starting");
  expect(controller.readingVideo).toBe(false);
  controller.observe({ id: 1, phase: "active", reason: "none" });
  expect(controller.state.phase).toBe("starting");
  expect(controller.readingVideo).toBe(true);
  controller.displayed();
  expect(controller.state.phase).toBe("active");
  controller.setEnabled(false);
  controller.displayed();
  expect(controller.state).toMatchObject({ wanted: false, phase: "off" });
  expect(controller.readingVideo).toBe(false);
  await vi.waitFor(() =>
    expect(video().at(-1)).toEqual({ op: "video", quality: 0 }),
  );
});

it.each([
  "canceled",
  "interrupted",
  "disconnected",
  "locked",
  "permission",
] as const)("returns to Off after %s and never reopens consent automatically", async (reason) => {
  controller.setEnabled(true);
  await settled();
  controller.observe({ id: 1, phase: "off", reason });
  await vi.advanceTimersByTimeAsync(70_000);
  expect(controller.state).toMatchObject({ wanted: false, phase: "off" });
  expect(video()).toEqual([{ op: "video", quality: 2 }]);
  controller.setEnabled(true);
  await settled();
  expect(video()).toHaveLength(2);
});

it("cancels an unanswered request after a bounded wait and allows retry", async () => {
  controller.setEnabled(true);
  await settled();
  await vi.advanceTimersByTimeAsync(65_000);
  expect(controller.state).toMatchObject({
    wanted: false,
    phase: "off",
    unavailable: false,
  });
  expect(video().at(-1)).toEqual({ op: "video", quality: 0 });
  controller.setEnabled(true);
  await settled();
});

it("stops if a decoder never produces a frame, even when host status stays active", async () => {
  controller.setEnabled(true);
  await settled();
  controller.observe({ id: 1, phase: "active", reason: "none" });
  for (let i = 0; i < 21; i++) {
    controller.observe({ id: 1, phase: "active", reason: "none" });
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(controller.state.phase).toBe("off");
  expect(video().at(-1)).toEqual({ op: "video", quality: 0 });
});

it("stops stalled decoded video and reports unsupported decoding without reopening consent", async () => {
  controller.setEnabled(true);
  await settled();
  controller.observe({ id: 1, phase: "active", reason: "none" });
  controller.displayed();
  await vi.advanceTimersByTimeAsync(10_250);
  expect(controller.state.phase).toBe("off");
  controller.fail("This browser supports still frames.", true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(controller.state).toMatchObject({
    wanted: false,
    unavailable: true,
    message: "This browser supports still frames.",
  });
  expect(video().every((c, i) => i === 0 || c.quality === 0)).toBe(true);
});

it("does not apply a late acknowledgement after the viewer closes", async () => {
  let release = () => {};
  start = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  controller.setEnabled(true);
  controller.close();
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(commands).toEqual([{ op: "video", quality: 2 }]);
});

it("reports an unconfirmed remote stop and keeps explicit retry available", async () => {
  controller.setEnabled(true);
  await settled();
  stopError = true;
  controller.setEnabled(false);
  await vi.waitFor(() =>
    expect(controller.state.message).toContain(
      "Couldn’t confirm that screen sharing stopped",
    ),
  );
  expect(controller.state).toMatchObject({
    wanted: false,
    phase: "off",
    unavailable: false,
  });
  stopError = false;
  controller.setEnabled(true);
  await settled();
});

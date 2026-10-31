import { RemoteMedia } from "@remote/client/control-session";
import { afterEach, expect, it, vi } from "vitest";
import { MediaReceiver } from "../src/media-receiver.js";

const owners: MediaReceiver[] = [];
function receiver() {
  const owner = new MediaReceiver(vi.fn());
  owners.push(owner);
  return owner;
}
function nativeStream() {
  let sequence = 0;
  const stopped = vi.fn(async () => {
    stream.push({
      kind: "event",
      stream: 1,
      sequence: ++sequence,
      timestamp: 1,
      width: 0,
      height: 0,
      key: false,
      data: new Uint8Array([2, 7]),
    });
  });
  const stream = new RemoteMedia(1, "jpeg", stopped, () => {}, vi.fn());
  stream.sent = true;
  return {
    stream,
    stopped,
    frame: () =>
      stream.push({
        kind: "jpeg",
        stream: 1,
        sequence: ++sequence,
        timestamp: 1,
        width: 1,
        height: 1,
        key: false,
        data: new Uint8Array([255, 216, 255, 217]),
      }),
  };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  vi.useRealTimers();
});
it("cancels pending playback permission without later opening a native sensor", async () => {
  const owner = receiver(),
    open = vi.fn();
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const sink = { push: vi.fn(), close: vi.fn() };
  owner.start(open, sink, gate);
  await owner.stop();
  ready();
  await Promise.resolve();
  expect(open).not.toHaveBeenCalled();
  expect(owner.state.phase).toBe("off");
  expect(sink.close).toHaveBeenCalled();
});
it("stops native capture after a decode failure even if local sink cleanup also fails", async () => {
  const owner = receiver(),
    phone = nativeStream();
  owner.start(async () => phone.stream, {
    push: () => {
      throw Error("Decode failed");
    },
    close: () => {
      throw Error("Cleanup failed");
    },
  });
  await Promise.resolve();
  phone.frame();
  await vi.waitFor(() => expect(owner.state.phase).toBe("off"));
  expect(phone.stopped).toHaveBeenCalledOnce();
  expect(owner.state.message).toBe("Decode failed");
});
it("reports Live only after actual display and releases without restarting", async () => {
  const owner = receiver(),
    phone = nativeStream(),
    open = vi.fn(async () => phone.stream);
  const pushed = vi.fn();
  owner.start(open, { push: pushed, close: vi.fn() });
  await Promise.resolve();
  phone.frame();
  await vi.waitFor(() => expect(pushed).toHaveBeenCalledOnce());
  expect(owner.state.phase).toBe("starting");
  owner.displayed();
  expect(owner.state.phase).toBe("live");
  await owner.stop("Sharing stopped while this page was hidden.");
  expect(phone.stopped).toHaveBeenCalledOnce();
  expect(owner.state).toMatchObject({
    phase: "off",
    message: expect.stringContaining("hidden"),
  });
  expect(open).toHaveBeenCalledOnce();
});
it("stops a source that keeps sending packets but never produces useful playback", async () => {
  vi.useFakeTimers();
  const owner = receiver(),
    phone = nativeStream();
  owner.start(async () => phone.stream, { push: vi.fn(), close: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 11; i++) {
    phone.frame();
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(owner.state.phase).toBe("off");
  expect(owner.state.message).toContain("stopped responding");
  expect(phone.stopped).toHaveBeenCalledOnce();
});

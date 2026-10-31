import {
  type CameraOptions,
  MediaError,
  RemoteMedia,
} from "@remote/client/control-session";
import type { ControlState } from "@remote/protocol/control";
import { MEDIA_REASONS, type MediaReason } from "@remote/protocol/media";

/** Browser-only UI fixture. Transport/native behavior is qualified separately on the phones. */
export function sensorFixture(
  state: ControlState,
  jpeg: Uint8Array<ArrayBuffer>,
) {
  state.media = {
    v: 1,
    camera: {
      available: true,
      allowed: true,
      permission: true,
      front: true,
      rear: true,
      stream: 0,
      phase: "off",
      reason: "none",
    },
    microphone: {
      available: true,
      allowed: true,
      permission: true,
      stream: 0,
      phase: "off",
      reason: "none",
    },
  };
  let next = 0,
    delay = 0,
    samples = 0;
  const starts: string[] = [];
  const contended = new Set<"camera" | "microphone">();
  const stops: number[] = [];
  const running = new Map<
    number,
    {
      sensor: "camera" | "microphone";
      stream: RemoteMedia;
      timer: ReturnType<typeof setInterval>;
      sequence: number;
    }
  >();
  function end(id: number, reason: MediaReason) {
    const entry = running.get(id);
    if (!entry) return;
    clearInterval(entry.timer);
    entry.stream.push({
      kind: "event",
      stream: id,
      sequence: ++entry.sequence,
      timestamp: 1,
      width: 0,
      height: 0,
      key: false,
      data: new Uint8Array([
        reason === "stopped" ? 2 : 3,
        MEDIA_REASONS.indexOf(reason),
      ]),
    });
  }
  async function start(
    sensor: "camera" | "microphone",
    options: CameraOptions = {},
  ) {
    options.signal?.throwIfAborted();
    if (contended.has(sensor))
      throw new MediaError("busy", "Native sensor busy");
    const ready = state.media?.[sensor];
    if (!ready?.allowed)
      throw new MediaError("disabled", "Enable remote sharing on the phone.");
    if (!ready.permission)
      throw new MediaError("permission", "Allow access on the phone.");
    if (sensor === "camera" && options.format !== "jpeg")
      throw new MediaError(
        "unavailable",
        "This fixture provides still frames.",
      );
    if (delay)
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          options.signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const timer = setTimeout(done, delay);
        const cancel = () => {
          clearTimeout(timer);
          reject(new DOMException("Canceled", "AbortError"));
        };
        options.signal?.addEventListener("abort", cancel, { once: true });
      });
    options.signal?.throwIfAborted();
    starts.push(sensor);
    const id = ++next;
    const stream = new RemoteMedia(
      id,
      sensor === "camera" ? "jpeg" : "pcm",
      async () => {
        stops.push(id);
        end(id, "stopped");
      },
      () => {
        const entry = running.get(id);
        if (entry) clearInterval(entry.timer);
        running.delete(id);
      },
      () => close(),
    );
    stream.sent = true;
    const entry = {
      sensor,
      stream,
      sequence: 1,
      timer: setInterval(
        () => {
          const data = sensor === "camera" ? jpeg : new Uint8Array(640);
          if (sensor === "microphone") {
            const pcm = new DataView(data.buffer);
            for (let i = 0; i < 320; i++)
              pcm.setInt16(
                i * 2,
                Math.round(
                  4096 * Math.sin(((samples + i) * 2 * Math.PI * 440) / 16000),
                ),
                true,
              );
            samples += 320;
          }
          stream.push({
            kind: sensor === "camera" ? "jpeg" : "pcm",
            stream: id,
            sequence: ++entry.sequence,
            timestamp: entry.sequence * 20000,
            width: sensor === "camera" ? 320 : 16000,
            height: sensor === "camera" ? 240 : 1,
            key: false,
            data,
          });
        },
        sensor === "camera" ? 250 : 20,
      ),
    };
    running.set(id, entry);
    stream.push({
      kind: "event",
      stream: id,
      sequence: 1,
      timestamp: 1,
      width: 0,
      height: 0,
      key: false,
      data: new Uint8Array([1, 0]),
    });
    const cancel = () => {
      void stream.stop();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    void stream.closed.then(() =>
      options.signal?.removeEventListener("abort", cancel),
    );
    return stream;
  }
  function close() {
    for (const { stream, timer } of running.values()) {
      clearInterval(timer);
      stream.finish("disconnected");
    }
  }
  return {
    startCamera: (options: CameraOptions) => start("camera", options),
    startMicrophone: (options: { signal?: AbortSignal }) =>
      start("microphone", options),
    close,
    status() {
      if (!state.media) return;
      for (const sensor of ["camera", "microphone"] as const) {
        const active = [...running.values()].find((v) => v.sensor === sensor);
        Object.assign(state.media[sensor], {
          stream: active?.stream.id ?? 0,
          phase: active?.stream.phase ?? "off",
        });
      }
    },
    evidence: {
      starts,
      stops,
      contend: (sensor: "camera" | "microphone", value: boolean) => {
        if (value) contended.add(sensor);
        else contended.delete(sensor);
      },
      async burst() {
        for (let i = 0; i < 20; i++) {
          for (const [id, entry] of running) {
            if (entry.sensor !== "microphone") continue;
            const data = new Uint8Array(640),
              pcm = new DataView(data.buffer);
            for (let j = 0; j < 320; j++)
              pcm.setInt16(
                j * 2,
                Math.round(
                  4096 * Math.sin(((samples + j) * 2 * Math.PI * 440) / 16000),
                ),
                true,
              );
            samples += 320;
            entry.stream.push({
              kind: "pcm",
              stream: id,
              sequence: ++entry.sequence,
              timestamp: entry.sequence * 20000,
              width: 16000,
              height: 1,
              key: false,
              data,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
      configure: (
        sensor: "camera" | "microphone",
        flags: { allowed?: boolean; permission?: boolean },
      ) => {
        if (state.media) Object.assign(state.media[sensor], flags);
      },
      active: () => [...running.values()].map((v) => v.sensor),
      revoke: (sensor: "camera" | "microphone", reason: MediaReason) => {
        for (const [id, entry] of running)
          if (entry.sensor === sensor) end(id, reason);
      },
      delay: (ms: number) => {
        delay = ms;
      },
    },
  };
}

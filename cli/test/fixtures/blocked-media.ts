/** Process-boundary synthetic source. Crypto and real native capture are qualified separately. */
import { RemoteMedia, RemoteSession } from "@remote/client/control-session";
import { Store } from "../../src/store.js";

Store.load = async () =>
  ({
    identity: {},
    select: () => ({ grant: {}, origin: "https://example.test" }),
  }) as never;
RemoteSession.connect = async () => {
  let active = true,
    stream: RemoteMedia | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    sequence = 0;
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    process.stderr.write("sensor-stopped\n");
  };
  return {
    state: {
      type: "state",
      v: 1,
      media: {
        v: 1,
        camera: {
          available: false,
          allowed: false,
          permission: false,
          front: false,
          rear: false,
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
      },
    },
    session: {
      get connected() {
        return active;
      },
      close() {
        active = false;
        stop();
        stream?.finish("disconnected");
        process.stderr.write("closed\n");
      },
      async command() {
        process.stderr.write("large-reply\n");
        return {
          id: 2,
          kind: "image",
          scene: 1,
          width: 1080,
          height: 2400,
          jpeg: new Uint8Array(1000000),
        };
      },
      async startMicrophone({ signal }: { signal: AbortSignal }) {
        stream = new RemoteMedia(
          1,
          "pcm",
          async () => {
            stop();
            stream?.push({
              kind: "event",
              stream: 1,
              sequence: ++sequence,
              timestamp: 1,
              width: 0,
              height: 0,
              key: false,
              data: new Uint8Array([2, 7]),
            });
          },
          () => {},
          () => {
            active = false;
            stop();
          },
        );
        stream.sent = true;
        timer = setInterval(
          () =>
            stream?.push({
              kind: "pcm",
              stream: 1,
              sequence: ++sequence,
              timestamp: sequence * 20000,
              width: 16000,
              height: 1,
              key: false,
              data: new Uint8Array(640),
            }),
          20,
        );
        signal.addEventListener(
          "abort",
          () => {
            void stream?.stop().catch(() => {});
          },
          { once: true },
        );
        return stream;
      },
    },
  } as never;
};
await import("../../src/main.js");

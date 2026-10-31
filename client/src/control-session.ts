import type { Identity } from "@remote/protocol";
import {
  type Command,
  type ControlState,
  encodeCommand,
  type Reply,
} from "@remote/protocol/control";
import type { Grant } from "@remote/protocol/enrollment";
import {
  MEDIA_RENEW_MS,
  type MediaPacket,
  type MediaReason,
} from "@remote/protocol/media";
import { LaneReader } from "./lane-reader.js";
import { MediaError, RemoteMedia } from "./media-stream.js";
import type { openEncryptedSession } from "./relay.js";

export { MediaError, RemoteMedia } from "./media-stream.js";

export type Lane = Pick<
  Awaited<ReturnType<typeof openEncryptedSession>>,
  "close" | "send" | "read"
>;
export interface SessionAdapters {
  open: (
    identity: Identity,
    grant: Grant,
    report: (s: string) => void,
    signal: AbortSignal,
  ) => Promise<Lane>;
  direct?: (
    identity: Identity,
    grant: Grant,
    offer: (sdp: string) => Promise<string>,
    signal: AbortSignal,
  ) => Promise<Lane>;
}
class RecoveredAction extends Error {}
class CanceledAction extends Error {}
const mediaResultReasons: Readonly<Record<number, MediaReason>> = {
  10: "permission",
  11: "disabled",
  6: "busy",
  8: "disconnected",
  7: "interrupted",
  4: "unavailable",
};
export interface CameraOptions {
  facing?: "rear" | "front";
  format?: "jpeg" | "h264";
  fps?: number;
  signal?: AbortSignal;
}
/** Ordered ordinary actions, separate priority Stop/Renew, and one reader/writer for each immutable crypto lane. */
export class RemoteSession {
  private sequence = 0;
  private queued = 0;
  private priorityQueued = 0;
  private active = true;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private lane: Lane;
  private readonly readers = new Map<Lane, LaneReader>();
  private readonly writers = new Map<Lane, Promise<void>>();
  private readonly failedLanes = new Set<Lane>();
  private readonly closedLanes = new Set<Lane>();
  private readonly streams = new Map<
    number,
    { stream: RemoteMedia; lane: Lane }
  >();
  private readonly renewing = new Set<number>();
  private nextStream = 0;
  private starts = 0;
  private latestState: ControlState | undefined;
  private detach: (() => void) | undefined;
  private upgradeTimer: ReturnType<typeof setTimeout> | undefined;
  private upgradeTask: Promise<void> | undefined;
  private recovery: Promise<void> | undefined;
  private readonly renewTimer: ReturnType<typeof setInterval>;
  get connected() {
    return this.active;
  }
  get path() {
    return this.lane === this.relay ? "relay" : "direct";
  }
  private constructor(
    private readonly relay: Lane,
    private readonly adapters: SessionAdapters,
    private readonly identity: Identity,
    private readonly grant: Grant,
  ) {
    this.lane = relay;
    this.renewTimer = setInterval(() => this.renew(), MEDIA_RENEW_MS);
    this.reader(relay);
  }
  static async connect(
    identity: Identity,
    grant: Grant,
    report: (s: string) => void,
    signal: AbortSignal,
    adapters: SessionAdapters,
    prepared?: Lane,
  ) {
    if (signal.aborted) {
      prepared?.close();
      signal.throwIfAborted();
    }
    const session = new RemoteSession(
      prepared ?? (await adapters.open(identity, grant, report, signal)),
      adapters,
      identity,
      grant,
    );
    if (signal.aborted) {
      session.close();
      signal.throwIfAborted();
    }
    const stop = () => session.close();
    session.detach = () => signal.removeEventListener("abort", stop);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const reply = await session.command({ op: "start" });
      if (reply.kind !== "state")
        throw new Error("Update the phone app to enable remote control");
      if (adapters.direct)
        session.upgradeTimer = setTimeout(() => {
          void session.upgrade();
        }, 1000);
      return { session, state: reply.state };
    } catch (error) {
      session.close();
      throw error;
    }
  }
  private reader(lane: Lane) {
    let reader = this.readers.get(lane);
    if (!reader) {
      reader = new LaneReader(
        lane,
        (packet) => this.media(lane, packet),
        (error) => this.lost(lane, error),
      );
      this.readers.set(lane, reader);
    }
    return reader;
  }
  private write(lane: Lane, bytes: Uint8Array<ArrayBuffer>) {
    const task = (this.writers.get(lane) ?? Promise.resolve()).then(
      async () => {
        if (!this.active || this.failedLanes.has(lane))
          throw new Error("Connection ended");
        await lane.send(bytes);
      },
    );
    // Encryption must complete and be sent in nonce order, including priority commands.
    this.writers.set(
      lane,
      task.catch(() => {}),
    );
    return task;
  }
  private async exchange(
    command: Command,
    lane = this.lane,
    sent?: () => void,
  ) {
    const id = ++this.sequence,
      encoded = encodeCommand(id, command);
    const response = this.reader(lane).wait(id);
    try {
      sent?.();
      const [reply] = await Promise.all([response, this.write(lane, encoded)]);
      if (reply.kind === "state" && lane === this.lane)
        this.latestState = reply.state;
      return reply;
    } catch (error) {
      this.lost(
        lane,
        error instanceof Error ? error : new Error("Connection ended"),
      );
      throw error;
    } finally {
      encoded.fill(0);
    }
  }
  private lost(lane: Lane, error: Error) {
    if (this.failedLanes.has(lane)) return;
    this.failedLanes.add(lane);
    this.readers.get(lane)?.close(error);
    this.closeLane(lane);
    for (const { stream, lane: owner } of [...this.streams.values()])
      if (owner === lane) stream.finish("disconnected");
    if (!this.active) return;
    if (lane === this.relay) {
      this.close();
      return;
    }
    if (lane === this.lane) {
      const recovery = this.recover();
      this.pending = this.pending
        .catch(() => {})
        .then(() => recovery)
        .catch(() => this.close());
    }
  }
  private recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    const retired = this.lane;
    if (retired !== this.relay) {
      for (const { stream, lane } of [...this.streams.values()])
        if (lane === retired) stream.finish("disconnected");
      this.readers.get(retired)?.close();
      this.failedLanes.add(retired);
      this.closeLane(retired);
    }
    // The established relay retains its keys and monotonic nonce counters; only its command owner is replaced.
    this.lane = this.relay;
    this.starts = 0;
    this.recovery = this.exchange({ op: "start" }, this.relay)
      .then((reply) => {
        if (reply.kind !== "state")
          throw new Error("Relay recovery unavailable");
      })
      .finally(() => {
        this.recovery = undefined;
      });
    return this.recovery;
  }
  private upgrade(): Promise<void> {
    clearTimeout(this.upgradeTimer);
    if (this.upgradeTask) return this.upgradeTask;
    const task = this.pending.then(async () => {
      if (!this.active || !this.adapters.direct) return;
      try {
        const direct = await this.adapters.direct(
          this.identity,
          this.grant,
          async (sdp) => {
            const response = await this.exchange(
              { op: "directOffer", sdp },
              this.relay,
            );
            if (response.kind !== "directAnswer")
              throw new Error("Direct connection unavailable");
            return response.sdp;
          },
          this.abort.signal,
        );
        if (!this.active) {
          this.closeLane(direct);
          return;
        }
        this.lane = direct;
        this.reader(direct);
        const started = await this.exchange({ op: "start" }, direct);
        if (started.kind !== "state")
          throw new Error("Direct control unavailable");
        this.starts = 0;
      } catch {
        if (this.active) await this.recover();
      }
    });
    this.upgradeTask = task;
    this.pending = task.catch(() => this.close());
    return task;
  }
  command(command: Command): Promise<Reply> {
    if (["cameraStart", "microphoneStart"].includes(command.op))
      return Promise.reject(
        new MediaError(
          "unsupported",
          "Start a subscription with startCamera or startMicrophone",
        ),
      );
    if (command.op === "mediaStop" || command.op === "mediaRenew") {
      if (!this.latestState?.media)
        return Promise.reject(
          new MediaError(
            "unsupported",
            "Update the phone app to enable camera and microphone access",
          ),
        );
      return this.priority(command);
    }
    if (command.op === "directOffer" && this.streams.size)
      return Promise.reject(
        new MediaError("busy", "Stop sharing before changing the connection"),
      );
    return this.enqueue(command);
  }
  private enqueue(
    command: Command,
    guard: () => boolean = () => true,
    sent?: () => void,
  ): Promise<Reply> {
    if (!this.active || this.queued >= 8)
      return Promise.reject(new Error("Phone is busy. Try again."));
    this.queued++;
    const task = this.pending.then(async () => {
      if (!this.active) throw new Error("Session ended");
      if (!guard()) throw new CanceledAction("Media request canceled");
      const lane = this.lane;
      try {
        return await this.exchange(command, lane, sent);
      } catch (error) {
        if (lane !== this.relay && this.active) {
          await this.recover();
          throw new RecoveredAction(
            "Direct connection interrupted. Continued through the relay; the action was not retried.",
          );
        }
        throw error;
      }
    });
    this.pending = task.catch((error) => {
      if (
        !(error instanceof RecoveredAction) &&
        !(error instanceof CanceledAction)
      )
        this.close();
    });
    return task.finally(() => {
      this.queued--;
    });
  }
  private priority(command: Command): Promise<Reply> {
    if (!this.active || this.priorityQueued >= 4)
      return Promise.reject(new Error("Sharing control is unavailable"));
    this.priorityQueued++;
    return this.exchange(command).finally(() => {
      this.priorityQueued--;
    });
  }
  startCamera(options: CameraOptions = {}) {
    return this.startMedia("camera", options);
  }
  startMicrophone(options: { signal?: AbortSignal } = {}) {
    return this.startMedia("microphone", options);
  }
  private async startMedia(
    sensor: "camera" | "microphone",
    options: CameraOptions,
  ) {
    options.signal?.throwIfAborted();
    const facing = options.facing ?? "rear",
      format = options.format ?? "h264",
      fps = options.fps ?? (format === "jpeg" ? 1 : 15);
    if (sensor === "camera") {
      try {
        encodeCommand(1, {
          op: "cameraStart",
          stream: 1,
          facing,
          format,
          fps,
        }).fill(0);
      } catch {
        throw new MediaError("unavailable", "Invalid camera options");
      }
    }
    // Complete or cancel the scheduled initial route selection BEFORE reserving any sensor.
    if (this.adapters.direct) await this.upgrade();
    if (this.recovery) await this.recovery;
    options.signal?.throwIfAborted();
    const reply = await this.command({ op: "status" });
    options.signal?.throwIfAborted();
    if (reply.kind !== "state" || !reply.state.media)
      throw new MediaError(
        "unsupported",
        "Update the phone app to enable camera and microphone access",
      );
    const ready = reply.state.media[sensor];
    if (!ready.allowed)
      throw new MediaError(
        "disabled",
        `Enable remote ${sensor} in the phone settings`,
      );
    if (!ready.permission)
      throw new MediaError(
        "permission",
        `Allow ${sensor} permission on the phone`,
      );
    if (
      !ready.available ||
      (sensor === "camera" && !reply.state.media.camera[facing])
    )
      throw new MediaError("unavailable", `Phone ${sensor} is unavailable`);
    if (ready.phase !== "off")
      throw new MediaError("busy", `Phone ${sensor} is already sharing`);
    if (++this.starts > 1024 || this.nextStream >= 0x7fffffff)
      throw new MediaError(
        "unavailable",
        "Reconnect to start more media streams",
      );
    const id = ++this.nextStream;
    const stream = new RemoteMedia(
      id,
      sensor === "camera" ? format : "pcm",
      async () => {
        const stopped = await this.priority({ op: "mediaStop", stream: id });
        if (stopped.kind !== "result" || stopped.code !== 0)
          throw new MediaError("interrupted", "Phone could not stop sharing");
      },
      () => {
        this.streams.delete(id);
      },
      () => this.close(),
    );
    this.streams.set(id, { stream, lane: this.lane });
    const cancel = () => {
      void stream.stop().catch(() => {});
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    void stream.closed.then(() =>
      options.signal?.removeEventListener("abort", cancel),
    );
    if (options.signal?.aborted) cancel();
    try {
      const command: Command =
        sensor === "camera"
          ? { op: "cameraStart", stream: id, facing, format, fps }
          : { op: "microphoneStart", stream: id };
      const started = await this.enqueue(
        command,
        () => stream.active && !options.signal?.aborted,
        () => {
          stream.sent = true;
        },
      );
      if (started.kind !== "result" || started.code !== 0) {
        const reason: MediaReason =
          started.kind !== "result"
            ? "unavailable"
            : (mediaResultReasons[started.code] ?? "unavailable");
        stream.finish(reason);
        throw new MediaError(
          reason,
          `Phone ${sensor} could not start (${reason})`,
        );
      }
      if (options.signal?.aborted) {
        await stream.stop();
        options.signal.throwIfAborted();
      }
      if (!stream.active)
        throw new MediaError(
          stream.reason,
          `Phone ${sensor} sharing ended (${stream.reason})`,
        );
      return stream;
    } catch (error) {
      stream.finish(
        error instanceof MediaError && error.code !== "unsupported"
          ? error.code
          : "interrupted",
      );
      if (error instanceof CanceledAction)
        throw new DOMException("Media request canceled", "AbortError");
      throw error;
    }
  }
  private media(lane: Lane, packet: MediaPacket) {
    const subscription = this.streams.get(packet.stream);
    if (subscription?.lane === lane) subscription.stream.push(packet);
  }
  private renew() {
    for (const { stream } of this.streams.values()) {
      if (!stream.active || !stream.sent || this.renewing.has(stream.id))
        continue;
      this.renewing.add(stream.id);
      void this.priority({ op: "mediaRenew", stream: stream.id })
        .then((reply) => {
          if (reply.kind !== "result" || reply.code !== 0) {
            // Rejection can precede asynchronous resource release and its authoritative
            // terminal reason (permission/revocation/timeout). Stop bounds that wait.
            void stream.stop().catch(() => {});
          }
        })
        .catch(() => this.close()) // Includes local priority saturation: never forget a still-owned sensor.
        .finally(() => this.renewing.delete(stream.id));
    }
  }
  private closeLane(lane: Lane) {
    if (this.closedLanes.has(lane)) return;
    this.closedLanes.add(lane);
    lane.close();
  }
  close() {
    if (!this.active) return;
    this.active = false;
    this.detach?.();
    clearTimeout(this.upgradeTimer);
    clearInterval(this.renewTimer);
    for (const { stream } of [...this.streams.values()])
      stream.finish("disconnected");
    for (const reader of this.readers.values()) reader.close();
    this.abort.abort();
    for (const lane of this.readers.keys()) this.closeLane(lane);
  }
}

import { MediaError, type RemoteMedia } from "@remote/client/control-session";
import type { MediaPacket, MediaReason } from "@remote/protocol/media";

export type SharingState = {
  phase: "off" | "starting" | "live" | "stopping";
  message: string;
};
export interface MediaSink {
  push(packet: MediaPacket): void | Promise<void>;
  close(): void;
}
const reasons: Record<MediaReason, string> = {
  none: "",
  stopped: "",
  permission:
    "Access was blocked. Open YepControl on the phone and check screen access, permissions and privacy controls.",
  disabled: "Remote sharing was turned off in the phone settings.",
  busy: "This sensor is in use. Stop other sharing or try again when it is free.",
  unavailable: "This sensor is unavailable on the phone.",
  disconnected: "Connection lost. Start sharing again after reconnecting.",
  timeout: "Sharing stopped responding. Start again to retry.",
  interrupted: "Sharing was interrupted. Start again to retry.",
};
type Job = {
  abort: AbortController;
  sink: MediaSink;
  stream?: RemoteMedia;
  done: Promise<void>;
  message: string;
  useful: number;
};

/** One explicit action owns its sink, subscription and cancellation. No automatic restart. */
export class MediaReceiver {
  private job: Job | undefined;
  private closed = false;
  state: SharingState = { phase: "off", message: "" };
  constructor(private readonly notify: (state: SharingState) => void) {}
  get busy() {
    return this.job !== undefined;
  }
  private publish(phase: SharingState["phase"], message = "") {
    this.state = { phase, message };
    if (!this.closed) this.notify(this.state);
  }
  displayed() {
    if (!this.job || this.job.abort.signal.aborted) return;
    this.job.useful = Date.now();
    if (this.state.phase === "starting") this.publish("live");
  }
  start(
    open: (signal: AbortSignal) => Promise<RemoteMedia>,
    sink: MediaSink,
    ready: Promise<void> = Promise.resolve(),
  ) {
    if (this.job || this.closed) {
      sink.close();
      void ready.catch(() => {});
      return;
    }
    const job: Job = {
      abort: new AbortController(),
      sink,
      done: Promise.resolve(),
      message: "",
      useful: Date.now(),
    };
    this.job = job;
    this.publish("starting");
    job.done = this.run(job, open, ready);
  }
  private async run(
    job: Job,
    open: (signal: AbortSignal) => Promise<RemoteMedia>,
    ready: Promise<void>,
  ) {
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          job.abort.signal.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => finish(new Error("Canceled"));
        const timer = setTimeout(
          () =>
            finish(new Error("Playback could not start. Try Listen again.")),
          5000,
        );
        job.abort.signal.addEventListener("abort", cancel, { once: true });
        ready.then(() => finish(), finish);
        if (job.abort.signal.aborted) cancel();
      });
      job.abort.signal.throwIfAborted();
      job.stream = await open(job.abort.signal);
      job.useful = Date.now();
      while (!job.abort.signal.aborted && job.stream.active) {
        const packet = await job.stream.read(1000);
        if (job.abort.signal.aborted) break;
        if (packet) await job.sink.push(packet);
        if (Date.now() - job.useful > 10000)
          throw new Error("Sharing stopped responding. Start again to retry.");
      }
      if (!job.message && !job.abort.signal.aborted)
        job.message = reasons[job.stream.reason];
    } catch (error) {
      if (!job.abort.signal.aborted)
        job.message =
          error instanceof MediaError && error.code !== "unsupported"
            ? reasons[error.code]
            : error instanceof Error
              ? error.message
              : "Sharing ended";
    } finally {
      this.closeSink(job);
      try {
        await job.stream?.stop();
      } catch (error) {
        job.message =
          error instanceof Error ? error.message : "Could not confirm Stop";
      }
      if (this.job === job) {
        this.job = undefined;
        this.publish("off", job.message);
      }
    }
  }
  stop(message = ""): Promise<void> {
    const job = this.job;
    if (!job) return Promise.resolve();
    job.message = message;
    this.publish("stopping", message);
    job.abort.abort();
    this.closeSink(job);
    return job.done;
  }
  private closeSink(job: Job) {
    try {
      job.sink.close();
    } catch {
      job.message ||= "Playback cleanup was interrupted.";
    }
  }
  close() {
    this.closed = true;
    void this.stop();
  }
}

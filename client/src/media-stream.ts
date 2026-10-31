import {
  MEDIA_REASONS,
  type MediaPacket,
  type MediaPhase,
  type MediaReason,
} from "@remote/protocol/media";

export class MediaError extends Error {
  constructor(
    readonly code: MediaReason | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

/** One explicit subscription, one consumer and a bounded mailbox. Never restarts itself. */
export class RemoteMedia {
  phase: MediaPhase = "starting";
  reason: MediaReason = "none";
  sent = false;
  readonly closed: Promise<MediaReason>;
  private ended!: (reason: MediaReason) => void;
  private queue: MediaPacket[] = [];
  private bytes = 0;
  private sequence = 0;
  private waiting: ((packet: MediaPacket | undefined) => void) | undefined;
  private stopping: Promise<void> | undefined;
  private overflowed = false;
  constructor(
    readonly id: number,
    readonly format: "jpeg" | "h264" | "pcm",
    private readonly stopRemote: () => Promise<void>,
    private readonly forget: () => void,
    private readonly uncertain: () => void,
  ) {
    this.closed = new Promise((resolve) => {
      this.ended = resolve;
    });
  }
  get active() {
    return this.phase !== "off";
  }
  push(packet: MediaPacket) {
    if (!this.active) return;
    if (packet.sequence <= this.sequence)
      throw new Error("Replayed media sequence");
    this.sequence = packet.sequence;
    if (packet.kind === "event") {
      if (packet.data[0] !== 1)
        this.finish(MEDIA_REASONS[packet.data[1] ?? 255] ?? "interrupted");
      return;
    }
    if (packet.kind !== this.format) throw new Error("Unexpected media format");
    if (this.overflowed) return; // Drain/discard until the terminal release event.
    this.phase = "live";
    if (this.waiting) {
      this.waiting(packet);
      return;
    }
    const maximum = this.format === "pcm" ? 6400 : 1048576;
    if (this.queue.length >= 4 || this.bytes + packet.data.length > maximum) {
      // Native Stop is independent from a blocked/abandoned consumer. Keep the
      // owner until release is confirmed, with the same timeout as explicit Stop.
      this.overflowed = true;
      this.queue = [];
      this.bytes = 0;
      void this.stop().catch(() => {});
      return;
    }
    this.queue.push(packet);
    this.bytes += packet.data.length;
  }
  async read(timeout = 15000): Promise<MediaPacket | undefined> {
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000)
      throw new Error("Invalid media read timeout");
    if (this.waiting)
      throw new MediaError("busy", "This media stream already has a reader");
    const next = this.queue.shift();
    if (next) {
      this.bytes -= next.data.length;
      return next;
    }
    if (!this.active) return undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), timeout);
      const done = (packet: MediaPacket | undefined) => {
        clearTimeout(timer);
        this.waiting = undefined;
        resolve(packet);
      };
      this.waiting = done;
    });
  }
  finish(reason: MediaReason) {
    if (!this.active) return;
    if (this.overflowed && reason === "stopped") reason = "interrupted";
    this.phase = "off";
    this.reason = reason;
    this.queue = [];
    this.bytes = 0;
    this.waiting?.(undefined);
    this.forget();
    this.ended(reason);
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.active) return Promise.resolve();
    if (!this.sent) {
      this.finish("stopped");
      return Promise.resolve();
    }
    this.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await this.stopRemote();
        await Promise.race([
          this.closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new MediaError(
                    "timeout",
                    "Phone did not confirm that sharing stopped",
                  ),
                ),
              5000,
            );
          }),
        ]);
      } catch (error) {
        if (this.active) {
          this.finish(
            error instanceof MediaError && error.code !== "unsupported"
              ? error.code
              : "interrupted",
          );
          this.uncertain();
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.stopping;
  }
}

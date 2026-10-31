import { resultMessage, type VideoState } from "@remote/protocol/control";
import type { RemoteSession } from "./control-session.js";

export type SmoothViewState = {
  wanted: boolean;
  phase: "off" | "consent" | "starting" | "active";
  message: string;
  unavailable: boolean;
};
const ended: Record<VideoState["reason"], string> = {
  none: "Smooth view ended. Still frames are available.",
  stopped: "",
  canceled: "Screen sharing canceled. Turn on Smooth view to try again.",
  timeout: "Screen sharing timed out. Turn on Smooth view to try again.",
  interrupted: "Screen sharing ended. Turn on Smooth view to try again.",
  locked: "Screen sharing stopped when the phone locked.",
  unavailable: "Couldn’t start smooth view. Still frames are available.",
  disconnected: "Screen sharing ended with the control session.",
  permission: "Screen sharing stopped because access was removed.",
};

/** Coalesce clicks, but always deliver Off before a subsequent On. Never retry consent automatically. */
export class SmoothView {
  state: SmoothViewState = {
    wanted: false,
    phase: "off",
    message: "",
    unavailable: false,
  };
  version = 0;
  private driving = false;
  private driveTask: Promise<void> | undefined;
  private stopNeeded = false;
  private closed = false;
  private host: VideoState | undefined;
  private deadline = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly session: Pick<RemoteSession, "command" | "connected">,
    private readonly notify: (state: SmoothViewState) => void,
    private readonly resetMedia: () => void,
  ) {
    this.timer = setInterval(() => {
      if (this.state.wanted && Date.now() >= this.deadline)
        this.fail("Smooth view stopped responding. Turn it on to try again.");
    }, 250);
  }

  private publish(patch: Partial<SmoothViewState>) {
    if (this.closed) return;
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next;
      this.notify(next);
    }
  }

  setEnabled(enabled: boolean) {
    if (this.closed) return;
    this.version++;
    if (!enabled) this.stopNeeded = true;
    this.host = undefined;
    this.resetMedia();
    this.deadline = Date.now() + 65_000;
    this.publish({
      wanted: enabled,
      phase: enabled ? "consent" : "off",
      message: enabled ? "Requesting smooth view…" : "Stopping screen sharing…",
    });
    if (!this.driving) this.driveTask = this.drive();
  }

  async stop() {
    if (!this.state.wanted && !this.driving) return;
    this.setEnabled(false);
    await this.driveTask;
    if (this.state.message) throw new Error(this.state.message);
  }

  private async drive() {
    this.driving = true;
    let applied = -1;
    try {
      while (!this.closed && (applied !== this.version || this.stopNeeded)) {
        const version = this.version;
        const enabled = !this.stopNeeded && this.state.wanted;
        if (!enabled) this.stopNeeded = false;
        const reply = await this.session.command({
          op: "video",
          quality: enabled ? 2 : 0,
        });
        if (this.closed) return;
        if (
          version !== this.version ||
          enabled !== this.state.wanted ||
          this.stopNeeded
        )
          continue;
        if (reply.kind !== "result" || reply.code !== 0)
          throw new Error(
            reply.kind === "result"
              ? resultMessage(reply.code)
              : "Couldn’t change smooth view.",
          );
        const status = await this.session.command({ op: "status" });
        if (version !== this.version || this.stopNeeded) continue;
        if (status.kind !== "state")
          throw new Error("Couldn’t confirm screen sharing.");
        this.observe(status.state.video, true);
        if (!enabled && this.state.message === "Stopping screen sharing…")
          this.publish({ message: "" });
        applied = version;
      }
    } catch (error) {
      if (!this.closed) {
        this.resetMedia();
        const detail =
          error instanceof Error ? error.message : "Connection ended";
        this.publish({
          wanted: false,
          phase: "off",
          message: this.state.wanted
            ? detail
            : `Couldn’t confirm that screen sharing stopped. ${detail}`,
        });
        // Stop is idempotent cleanup, never a repeated consent or input command.
        if (this.session.connected)
          void this.session
            .command({ op: "video", quality: 0 })
            .catch(() => {});
      }
    } finally {
      this.driving = false;
    }
  }

  observe(host: VideoState | undefined, fromCommand = false) {
    if (this.closed || (this.driving && !fromCommand)) return;
    if (!host || host.phase === "off") {
      this.host = host;
      if (this.state.wanted) {
        this.resetMedia();
        this.publish({
          wanted: false,
          phase: "off",
          message: host
            ? ended[host.reason]
            : "Update the phone app to use Smooth view.",
        });
      }
      return;
    }
    if (!this.state.wanted) return;
    if (this.host?.id !== host.id) this.resetMedia();
    if (
      host.phase !== "consent" &&
      (this.host?.id !== host.id || this.host.phase === "consent")
    )
      this.deadline = Date.now() + 20_000;
    this.host = host;
    if (host.phase === "consent") {
      this.publish({
        phase: "consent",
        message:
          "Approve screen sharing on the phone. Turn Smooth view off to cancel.",
      });
    } else if (this.state.phase !== "active") {
      this.publish({ phase: "starting", message: "Starting smooth view…" });
    }
  }

  get readingVideo() {
    return this.state.wanted && this.host?.phase === "active";
  }

  displayed() {
    if (!this.readingVideo) return;
    this.deadline = Date.now() + 10_000;
    this.publish({ phase: "active", message: "Smooth view" });
  }

  fail(message: string, unavailable = false) {
    this.setEnabled(false);
    this.publish({ message, unavailable });
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.resetMedia();
  }
}

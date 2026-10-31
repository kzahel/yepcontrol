import type { MediaPacket } from "@remote/protocol/media";
import type { MediaSink } from "./media-receiver.js";

/** Remote PCM playback only. Nothing requests the browser's microphone. */
export class PhoneAudio implements MediaSink {
  private readonly context: AudioContext;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private next = 0;
  private closed = false;
  private armed = false;
  constructor(
    private readonly played: () => void,
    interrupted: () => void,
  ) {
    if (typeof AudioContext === "undefined")
      throw new Error("Listening is unavailable in this browser.");
    this.context = new AudioContext({
      sampleRate: 16000,
      latencyHint: "interactive",
    });
    this.context.onstatechange = () => {
      if (this.armed && !this.closed && this.context.state !== "running")
        interrupted();
    };
  }
  /** Invoke directly from Listen, before awaiting network work, for user activation. */
  async resume() {
    await this.context.resume();
    if (this.closed) return;
    if (this.context.state !== "running")
      throw new Error("Audio playback is unavailable. Try Listen again.");
    this.armed = true;
  }
  push(packet: MediaPacket) {
    if (this.closed) return;
    if (packet.kind !== "pcm" || this.context.state !== "running")
      throw new Error("Audio playback paused. Choose Listen to start again.");
    const now = this.context.currentTime;
    this.next = Math.max(this.next, now + 0.04);
    const samples = packet.data.byteLength / 2;
    if (this.sources.size >= 16 || this.next + samples / 16000 - now > 0.25) {
      // Keep current sound rather than accumulating delay across delivery bursts
      // and independent capture/playback clocks. Never queue beyond 250 ms.
      this.discardQueued();
      this.next = now + 0.04;
    }
    const buffer = this.context.createBuffer(1, samples, 16000);
    const floats = buffer.getChannelData(0);
    const pcm = new DataView(
      packet.data.buffer,
      packet.data.byteOffset,
      packet.data.byteLength,
    );
    for (let i = 0; i < samples; i++)
      floats[i] = pcm.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (!this.closed) this.played();
    };
    source.start(this.next);
    this.sources.add(source);
    this.next += buffer.duration;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.armed = false;
    this.context.onstatechange = null;
    try {
      this.discardQueued();
    } finally {
      void this.context.close().catch(() => {});
    }
  }
  private discardQueued() {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
  }
}

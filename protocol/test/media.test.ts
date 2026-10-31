import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Command,
  decodeReply,
  encodeCommand,
  resultMessage,
} from "../src/control.js";
import {
  decodeMedia,
  encodeMedia,
  MEDIA_MAX_RECORD,
  type MediaPacket,
  parseMediaState,
} from "../src/media.js";

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/media-v1.json", import.meta.url), "utf8"),
) as {
  packets: (Omit<MediaPacket, "data"> & { dataHex: string; hex: string })[];
  commands: { id: number; command: Command; hex: string }[];
};
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
describe("negotiated media boundary", () => {
  it("matches shared native command and packet vectors without changing old opcodes", () => {
    for (const v of vectors.commands)
      expect(Buffer.from(encodeCommand(v.id, v.command)).toString("hex")).toBe(
        v.hex,
      );
    for (const { hex, dataHex, ...packet } of vectors.packets) {
      expect(
        Buffer.from(encodeMedia({ ...packet, data: bytes(dataHex) })).toString(
          "hex",
        ),
      ).toBe(hex);
      expect(decodeMedia(bytes(hex))).toEqual({
        ...packet,
        data: bytes(dataHex),
      });
    }
  });
  it("rejects numeric truncation, unbounded sources and ambiguous stream identifiers", () => {
    for (const stream of [-1, 0, 1.5, NaN, 0x80000000, 0x100000001]) {
      expect(() =>
        encodeCommand(1, { op: "microphoneStart", stream }),
      ).toThrow();
      expect(() =>
        encodeMedia({
          kind: "pcm",
          stream,
          sequence: 1,
          timestamp: 1,
          width: 16000,
          height: 1,
          key: false,
          data: bytes("0000"),
        }),
      ).toThrow();
    }
    expect(() =>
      encodeCommand(1, {
        op: "cameraStart",
        stream: 1,
        facing: "rear",
        format: "jpeg",
        fps: 6,
      }),
    ).toThrow();
    expect(() =>
      encodeCommand(1, {
        op: "cameraStart",
        stream: 1,
        facing: "front",
        format: "h264",
        fps: 1.5,
      }),
    ).toThrow();
    expect(encodeCommand(1, { op: "mediaStop", stream: 0 }).length).toBe(16);
  });
  it("validates lengths, replay metadata, geometry and media-specific fields before allocation", () => {
    for (const vector of vectors.packets) {
      const good = bytes(vector.hex);
      for (let length = 0; length < 34; length++)
        expect(() => decodeMedia(good.slice(0, length))).toThrow();
      for (const index of [0, 4, 5, 6]) {
        const bad = good.slice();
        bad[index] = 255;
        expect(() => decodeMedia(bad)).toThrow();
      }
      for (const offset of [8, 12]) {
        const bad = good.slice();
        new DataView(bad.buffer).setUint32(offset, 0);
        expect(() => decodeMedia(bad)).toThrow();
      }
      const bad = good.slice();
      new DataView(bad.buffer).setBigUint64(16, 2n ** 60n);
      expect(() => decodeMedia(bad)).toThrow();
    }
    const pcm = bytes(vectors.packets[2]?.hex ?? "");
    expect(() => decodeMedia(pcm.slice(0, -1))).toThrow();
    const badPcm = pcm.slice();
    new DataView(badPcm.buffer).setUint32(24, 48000);
    expect(() => decodeMedia(badPcm)).toThrow();
    const jpeg = bytes(vectors.packets[0]?.hex ?? "");
    const atLimit = new Uint8Array(MEDIA_MAX_RECORD);
    atLimit.set(jpeg);
    expect(decodeMedia(atLimit).data.length).toBe(MEDIA_MAX_RECORD - 32);
    const overLimit = new Uint8Array(MEDIA_MAX_RECORD + 1);
    overLimit.set(jpeg);
    expect(() => decodeMedia(overLimit)).toThrow();
    for (const [width, height] of [
      [1, 1],
      [4096, 4096],
    ]) {
      const valid = jpeg.slice();
      const view = new DataView(valid.buffer);
      view.setUint32(24, width ?? 0);
      view.setUint32(28, height ?? 0);
      expect(decodeMedia(valid).width).toBe(width);
    }
    for (const [width, height] of [
      [0, 240],
      [320, 0],
      [4097, 240],
      [320, 4097],
    ]) {
      const invalid = jpeg.slice();
      const view = new DataView(invalid.buffer);
      view.setUint32(24, width ?? 0);
      view.setUint32(28, height ?? 0);
      expect(() => decodeMedia(invalid)).toThrow();
    }
  });
  it("accepts existing results and new media refusal codes without widening arbitrary results", () => {
    for (let code = 0; code <= 11; code++) {
      const reply = bytes(
        `415250310200000000000001${code.toString(16).padStart(2, "0")}`,
      );
      expect(decodeReply(reply)).toEqual({ id: 1, kind: "result", code });
      expect(resultMessage(code)).not.toBe("Action failed");
    }
    expect(() => decodeReply(bytes("4152503102000000000000010c"))).toThrow();
  });
  it("requires complete readiness and actual stream state when the additive capability is present", () => {
    const sensor = {
      available: true,
      allowed: false,
      permission: false,
      stream: 0,
      phase: "off",
      reason: "none",
    };
    const state = {
      v: 1,
      camera: { ...sensor, front: true, rear: true },
      microphone: { ...sensor },
    };
    expect(parseMediaState(state)).toEqual(state);
    for (const patch of [
      { permission: undefined },
      { stream: 0, phase: "live" },
      { phase: "unknown" },
      { reason: "bad" },
      { allowed: "yes" },
    ]) {
      expect(() =>
        parseMediaState({ ...state, microphone: { ...sensor, ...patch } }),
      ).toThrow();
    }
    expect(() => parseMediaState({ ...state, camera: sensor })).toThrow();
  });
});

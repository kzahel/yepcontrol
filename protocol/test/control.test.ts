import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Command, decodeReply, encodeCommand } from "../src/control.js";

const vectors = JSON.parse(
  readFileSync(new URL("../vectors/control-v1.json", import.meta.url), "utf8"),
) as { id: number; command: Command; hex: string }[];
describe("control boundary", () => {
  it("matches shared Kotlin command vectors", () => {
    for (const v of vectors)
      expect(Buffer.from(encodeCommand(v.id, v.command)).toString("hex")).toBe(
        v.hex,
      );
  });
  it("rejects coordinates and durations that would change meaning during integer encoding", () => {
    for (const x of [-1, 1.5, NaN, Infinity, 2 ** 32])
      expect(() =>
        encodeCommand(1, { op: "tap", scene: 1, x, y: 0 }),
      ).toThrow();
    expect(() => encodeCommand(0, { op: "start" })).toThrow();
    expect(() =>
      encodeCommand(1, {
        op: "swipe",
        scene: 1,
        x: 0,
        y: 0,
        endX: 1,
        endY: 1,
        duration: 2001,
      }),
    ).toThrow();
    expect(() =>
      encodeCommand(1, { op: "text", text: "🌞".repeat(1025) }),
    ).toThrow();
    expect(() =>
      encodeCommand(1, { op: "launch", packageName: "x; command" }),
    ).toThrow();
  });
  it("rejects invalid and ambiguous multi-contact batches", () => {
    const batch = {
      scene: 1,
      gesture: 1,
      sequence: 0,
      duration: 40,
      contacts: [{ id: 0, held: true, path: [{ x: 1, y: 2 }] }],
    };
    expect(() =>
      encodeCommand(1, {
        op: "touch",
        batch: { ...batch, contacts: [...batch.contacts, ...batch.contacts] },
      }),
    ).toThrow();
    expect(() =>
      encodeCommand(1, { op: "touch", batch: { ...batch, duration: NaN } }),
    ).toThrow();
    expect(() =>
      encodeCommand(1, {
        op: "touch",
        batch: {
          ...batch,
          contacts: [{ id: 0, held: true, path: [{ x: NaN, y: 1 }] }],
        },
      }),
    ).toThrow();
  });
  it("only admits explicit bounded numeric unlock credentials", () => {
    for (const pin of ["", "123", "1".repeat(17), "1234\n", "１２３４", "123a"])
      expect(() => encodeCommand(1, { op: "unlock", pin })).toThrow();
    expect(
      Buffer.from(encodeCommand(8, { op: "unlock", pin: "314159" })).toString(
        "hex",
      ),
    ).toBe("415243310d00000000000008333134313539");
  });
  it("bounds encrypted direct signaling independently of text input", () => {
    expect(() => encodeCommand(1, { op: "directOffer", sdp: "bad" })).toThrow();
    expect(() =>
      encodeCommand(1, {
        op: "directOffer",
        sdp: `v=0\r\n${"x".repeat(32768)}`,
      }),
    ).toThrow();
    expect(
      encodeCommand(1, { op: "directOffer", sdp: `v=0\r\n${"x".repeat(8000)}` })
        .length,
    ).toBeGreaterThan(8000);
  });
  it("bounds video metadata before decoder allocation", () => {
    const record = new Uint8Array(56),
      v = new DataView(record.buffer);
    record.set([65, 82, 80, 49, 5, 0, 0, 0]);
    v.setUint32(8, 1);
    [1, 2, 720, 1600, 1080, 2400, 1].forEach((n, i) => {
      v.setUint32(12 + i * 4, n);
    });
    v.setBigUint64(40, 1000n);
    record.set([0, 0, 0, 1, 0x65, 1, 2, 3], 48);
    expect(decodeReply(record)).toMatchObject({
      kind: "video",
      key: true,
      scene: 2,
      timestamp: 1000,
    });
    for (const offset of [12, 16, 20, 24, 28, 32]) {
      const bad = record.slice();
      new DataView(bad.buffer).setUint32(offset, 0);
      expect(() => decodeReply(bad)).toThrow();
    }
    v.setUint32(36, 2);
    expect(() => decodeReply(record)).toThrow();
    v.setUint32(36, 1);
    v.setBigUint64(40, 2n ** 60n);
    expect(() => decodeReply(record)).toThrow();
    expect(() => encodeCommand(1, { op: "video", quality: 4 as 1 })).toThrow();
  });
  it("rejects unknown, oversized and malformed responses", () => {
    const good = new Uint8Array(
      Buffer.from("41525031020000000000000100", "hex"),
    );
    expect(decodeReply(good)).toEqual({ id: 1, kind: "result", code: 0 });
    for (const index of [0, 4, 5, 12]) {
      const bad = good.slice();
      bad[index] = 255;
      expect(() => decodeReply(bad)).toThrow();
    }
    expect(() => decodeReply(new Uint8Array(1048577))).toThrow();
  });
  it("keeps optional advanced readiness within the released state envelope", () => {
    const sensor = {
      available: true,
      allowed: true,
      permission: true,
      stream: 2147483647,
      phase: "live",
      reason: "none",
    };
    const state = {
      type: "state",
      v: 1,
      accessibility: true,
      locked: false,
      width: 16384,
      height: 16384,
      scene: 2147483647,
      device: {
        manufacturer: "界".repeat(80),
        model: "界".repeat(80),
        name: "界".repeat(80),
        android: "界".repeat(20),
        app: "界".repeat(40),
        sdk: 1000,
        connectionPreparation: 1,
      },
      videoActive: true,
      video: {
        v: 1,
        supported: true,
        phase: "active",
        reason: "none",
        id: 2147483647,
      },
      unlockSupported: true,
      unlockAllowed: true,
      savedPin: true,
      unlockBlocked: false,
      localSettings: false,
      a11y: 1,
      media: {
        v: 1,
        camera: { ...sensor, front: true, rear: true },
        microphone: sensor,
      },
    };
    const record = (advancedControl?: unknown) => {
      const payload = new TextEncoder().encode(
        JSON.stringify({ ...state, advancedControl }),
      );
      const bytes = new Uint8Array(12 + payload.length);
      bytes.set([65, 82, 80, 49, 1, 0, 0, 0]);
      new DataView(bytes.buffer).setUint32(8, 1);
      bytes.set(payload, 12);
      return bytes;
    };
    expect(decodeReply(record())).toMatchObject({ kind: "state" });
    const ready = { paired: true, running: true, ready: true };
    expect(record(ready).length).toBeLessThanOrEqual(2048);
    expect(decodeReply(record(ready))).toMatchObject({
      state: { advancedControl: ready },
    });
    for (const invalid of [
      null,
      "ready",
      { paired: true },
      { paired: false, running: true, ready: true },
      { paired: true, running: false, ready: true },
    ]) {
      expect(() => decodeReply(record(invalid))).toThrow(
        "Invalid advanced control state",
      );
    }
  });
  it("requires a bounded device report in every state", () => {
    const device = {
      manufacturer: "Google",
      model: "Pixel 9",
      name: "Kyle’s Pixel 9",
      android: "17",
      sdk: 37,
      app: "0.6.0",
    };
    function record(value: unknown) {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "state",
          v: 1,
          accessibility: true,
          locked: false,
          width: 1080,
          height: 2400,
          scene: 1,
          device: value,
        }),
      );
      const bytes = new Uint8Array(12 + payload.length);
      bytes.set([65, 82, 80, 49, 1, 0, 0, 0]);
      new DataView(bytes.buffer).setUint32(8, 1);
      bytes.set(payload, 12);
      return bytes;
    }
    expect(decodeReply(record(device))).toMatchObject({ state: { device } });
    for (const bad of [
      undefined,
      null,
      { ...device, model: "" },
      { ...device, name: "x".repeat(81) },
      { ...device, name: "Phone\nname" },
      { ...device, sdk: 0 },
      { ...device, android: 17 },
    ])
      expect(() => decodeReply(record(bad))).toThrow("Invalid device report");
  });
  it("validates capture lifecycle states without breaking stills on older beta hosts", () => {
    function record(video: unknown) {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "state",
          v: 1,
          accessibility: true,
          locked: false,
          width: 1080,
          height: 2400,
          scene: 1,
          device: {
            manufacturer: "Google",
            model: "Emulator",
            name: "Test phone",
            android: "16",
            sdk: 36,
            app: "0.6.0",
          },
          video,
        }),
      );
      const bytes = new Uint8Array(12 + payload.length);
      bytes.set([65, 82, 80, 49, 1, 0, 0, 0]);
      new DataView(bytes.buffer).setUint32(8, 1);
      bytes.set(payload, 12);
      return bytes;
    }
    expect(decodeReply(record(undefined))).toMatchObject({ kind: "state" });
    for (const phase of ["consent", "starting", "active", "off"]) {
      expect(
        decodeReply(record({ id: 1, phase, reason: "none" })),
      ).toMatchObject({ state: { video: { phase } } });
    }
    for (const video of [
      null,
      {},
      "active",
      { id: 0, phase: "active", reason: "none" },
      { id: -1, phase: "off", reason: "stopped" },
      { id: 2 ** 31, phase: "off", reason: "stopped" },
      { id: 1.5, phase: "consent", reason: "none" },
      { id: 1, phase: "unknown", reason: "none" },
      { id: 1, phase: "off", reason: "unknown" },
      { id: 1, phase: "consent", reason: "canceled" },
    ])
      expect(() => decodeReply(record(video))).toThrow("Invalid video state");
  });
  it("validates the additive local-settings notice from the phone", () => {
    for (const localSettings of [undefined, true, false, "true", 1, null]) {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "state",
          v: 1,
          accessibility: true,
          locked: false,
          width: 1080,
          height: 2400,
          scene: 1,
          device: {
            manufacturer: "Google",
            model: "Emulator",
            name: "Test phone",
            android: "16",
            sdk: 36,
            app: "0.6.0",
          },
          localSettings,
        }),
      );
      const bytes = new Uint8Array(12 + payload.length);
      bytes.set([65, 82, 80, 49, 1, 0, 0, 0]);
      new DataView(bytes.buffer).setUint32(8, 1);
      bytes.set(payload, 12);
      if (localSettings === undefined || typeof localSettings === "boolean") {
        expect(decodeReply(bytes)).toMatchObject({ kind: "state" });
      } else {
        expect(() => decodeReply(bytes)).toThrow("Invalid unlock state");
      }
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDevice, parseDevice, sealDevice } from "../src/device.js";

const vector = JSON.parse(
  readFileSync(new URL("../vectors/device-v1.json", import.meta.url), "utf8"),
) as {
  secret: string;
  id: string;
  iv: string;
  plaintext: string;
  device: Parameters<typeof sealDevice>[2];
  sealed: string;
};
const iv = Uint8Array.from(Buffer.from(vector.iv, "hex"));
describe("device report sealed into a pairing offer", () => {
  it("matches the shared vector and opens with the QR secret", async () => {
    expect(JSON.stringify(vector.device)).toBe(vector.plaintext);
    expect(await sealDevice(vector.secret, vector.id, vector.device, iv)).toBe(
      vector.sealed,
    );
    expect(await openDevice(vector.secret, vector.id, vector.sealed)).toEqual(
      vector.device,
    );
  });
  it("cannot be opened with another secret or for another pairing", async () => {
    await expect(
      openDevice("33".repeat(32), vector.id, vector.sealed),
    ).rejects.toThrow();
    await expect(
      openDevice(vector.secret, "44".repeat(16), vector.sealed),
    ).rejects.toThrow();
  });
  it("preserves the optional preparation extension without requiring it from 0.7.0", async () => {
    const device = { ...vector.device, connectionPreparation: 1 as const };
    expect(
      await openDevice(
        vector.secret,
        vector.id,
        await sealDevice(vector.secret, vector.id, device),
      ),
    ).toEqual(device);
    expect(parseDevice(vector.device)).not.toHaveProperty(
      "connectionPreparation",
    );
    expect(() =>
      parseDevice({ ...vector.device, connectionPreparation: true }),
    ).toThrow();
    expect(() =>
      parseDevice({ ...vector.device, connectionPreparation: 2 }),
    ).toThrow();
  });
  it("rejects malformed reports", () => {
    expect(() => parseDevice({ ...vector.device, app: "" })).toThrow();
    expect(() => parseDevice({ ...vector.device, extra: 1 })).not.toThrow();
  });
});

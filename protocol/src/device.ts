import { fromHex } from "./enrollment.js";
import { b64, concat, unb64, utf8 } from "./index.js";

/** What a phone reports about itself to paired viewers; sent on every authenticated contact. */
export interface DeviceInfo {
  manufacturer: string;
  model: string;
  /** The phone's own device name (Android Settings › About phone). */
  name: string;
  android: string;
  sdk: number;
  app: string;
  /** Host can retain a readiness check for promotion to control for 30 seconds. */
  connectionPreparation?: 1;
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= max &&
  value === value.trim() &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  !/[\u0000-\u001f\u007f-\u009f]/.test(value);
export function parseDevice(value: unknown): DeviceInfo {
  const d = value as Record<string, unknown> | null;
  if (
    !d ||
    typeof d !== "object" ||
    !text(d.manufacturer, 80) ||
    !text(d.model, 80) ||
    !text(d.name, 80) ||
    !text(d.android, 20) ||
    !text(d.app, 40) ||
    typeof d.sdk !== "number" ||
    !Number.isInteger(d.sdk) ||
    d.sdk < 1 ||
    d.sdk > 1000 ||
    (d.connectionPreparation !== undefined && d.connectionPreparation !== 1)
  )
    throw new Error("Invalid device report");
  return {
    manufacturer: d.manufacturer,
    model: d.model,
    name: d.name,
    android: d.android,
    sdk: d.sdk,
    app: d.app,
    ...(d.connectionPreparation === 1 ? { connectionPreparation: 1 } : {}),
  };
}

// The pairing offer passes through the relay; seal the report with the QR secret
// (which the relay never sees), bound to this pairing ID.
const label = "ara/pair/device/v1";
async function sealingKey(secret: string, id: string) {
  const ikm = await crypto.subtle.importKey(
    "raw",
    fromHex(secret, 32),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: fromHex(id, 16), info: utf8(label) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealDevice(
  secret: string,
  id: string,
  device: DeviceInfo,
  iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12)),
): Promise<string> {
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: concat(utf8(label), fromHex(id, 16)),
    },
    await sealingKey(secret, id),
    utf8(JSON.stringify(device)),
  );
  return b64(concat(iv, new Uint8Array(sealed)));
}
export async function openDevice(
  secret: string,
  id: string,
  sealed: string,
): Promise<DeviceInfo> {
  const raw = unb64(sealed);
  if (raw.length < 29 || raw.length > 1200)
    throw new Error("Invalid device report");
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: raw.slice(0, 12),
      additionalData: concat(utf8(label), fromHex(id, 16)),
    },
    await sealingKey(secret, id),
    raw.slice(12),
  );
  return parseDevice(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)),
  );
}

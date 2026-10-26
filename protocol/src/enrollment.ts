/** Experimental QR enrollment contract: docs/pairing-relay-v1.md. */
import { type Bytes, b64, equal, unb64, utf8 } from "./index.js";
export interface Invitation {
  v: 1;
  origin: string;
  id: string;
  viewer: string;
  expires: number;
  secret: string;
  /** Browser-chosen label such as "Chrome on macOS"; shown to the phone owner, never trusted. */
  name: string;
}
export interface Grant {
  id: string;
  viewer: string;
  phone: string;
  expires: number;
  phoneSignature: string;
  mac: string;
  viewerSignature?: string;
}
export const fields = (...parts: (string | number)[]): Bytes => {
  if (parts.some((p) => String(p).includes("\n")))
    throw new Error("Invalid field");
  return utf8(parts.join("\n"));
};
export const hex = (value: Uint8Array): string =>
  Array.from(value, (n) => n.toString(16).padStart(2, "0")).join("");
export function fromHex(value: string, length: number): Bytes {
  if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value))
    throw new Error("Invalid hex");
  return Uint8Array.from(value.match(/../g) ?? [], (n) =>
    Number.parseInt(n, 16),
  );
}
export function keyBytes(value: string): Bytes {
  const key = unb64(value);
  if (key.length !== 65 || key[0] !== 4 || b64(key) !== value)
    throw new Error("Invalid key");
  return key;
}
export function originURL(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "https:")
    throw new Error("HTTPS origin required");
  return value;
}
export const createBytes = (
  origin: string,
  i: Pick<Invitation, "id" | "viewer" | "expires">,
): Bytes => fields("ara/pair/create/v1", origin, i.id, i.viewer, i.expires);
export const grantBytes = (
  origin: string,
  g: Pick<Grant, "id" | "viewer" | "phone" | "expires">,
): Bytes =>
  fields("ara/pair/grant/v1", origin, g.id, g.viewer, g.phone, g.expires);
export const authBytes = (
  origin: string,
  id: string,
  role: string,
  nonce: string,
): Bytes => fields("ara/relay/auth/v1", origin, id, role, nonce);
export const revokeBytes = (origin: string, id: string): Bytes =>
  fields("ara/pair/revoke/v1", origin, id);
export async function verifySignature(
  key: string,
  message: Bytes,
  signature: string,
): Promise<void> {
  const raw = unb64(signature);
  if (raw.length !== 64) throw new Error("Invalid signature");
  const imported = await crypto.subtle.importKey(
    "raw",
    keyBytes(key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      imported,
      raw,
      message,
    ))
  )
    throw new Error("Invalid signature");
}
export async function grantMac(secret: string, data: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromHex(secret, 32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
export async function verifyOffer(
  i: Invitation,
  g: Grant,
  now = Date.now(),
): Promise<void> {
  if (
    g.id !== i.id ||
    g.viewer !== i.viewer ||
    g.expires !== i.expires ||
    i.expires * 1000 <= now
  )
    throw new Error("Wrong or expired offer");
  const data = grantBytes(i.origin, g);
  if (!equal(await grantMac(i.secret, data), fromHex(g.mac, 32)))
    throw new Error("Untrusted phone");
  await verifySignature(g.phone, data, g.phoneSignature);
}
export function decodeInvitation(uri: string): Invitation {
  const url = new URL(uri);
  if (
    uri.length >= 4096 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== "/enroll" ||
    !url.hash
  )
    throw new Error("Invalid pairing code");
  const i = JSON.parse(
    new TextDecoder().decode(unb64(url.hash.slice(1))),
  ) as Invitation;
  if (i.v !== 1) throw new Error("Unsupported pairing code");
  originURL(i.origin);
  if (url.origin !== i.origin) throw new Error("Wrong pairing origin");
  fromHex(i.id, 16);
  fromHex(i.secret, 32);
  keyBytes(i.viewer);
  if (!validBrowserName(i.name)) throw new Error("Invalid browser name");
  if (
    !Number.isSafeInteger(i.expires) ||
    i.expires * 1000 <= Date.now() ||
    i.expires * 1000 > Date.now() + 301000
  )
    throw new Error("Expired pairing code");
  return i;
}
export const validBrowserName = (name: unknown): name is string =>
  typeof name === "string" &&
  name === name.trim() &&
  name.length >= 1 &&
  name.length <= 40 &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(name);
export const encodeInvitation = (i: Invitation): string =>
  `${originURL(i.origin)}/enroll#${b64(utf8(JSON.stringify(i)))}`;

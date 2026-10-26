import {
  fields,
  fromHex,
  grantMac,
  keyBytes,
  originURL,
  validBrowserName,
  verifySignature,
} from "./enrollment.js";
import { b64, equal, unb64, utf8 } from "./index.js";

export interface PhoneInvitation {
  v: 1;
  origin: string;
  id: string;
  phone: string;
  expires: number;
  secret: string;
}
export interface BrowserClaim {
  viewer: string;
  name: string;
  signature: string;
  mac: string;
}
export const phoneCreateBytes = (
  origin: string,
  i: Pick<PhoneInvitation, "id" | "phone" | "expires">,
) => fields("ara/pair/phone-create/v1", origin, i.id, i.phone, i.expires);

export const claimBytes = (
  origin: string,
  i: Pick<PhoneInvitation, "id" | "phone" | "expires">,
  claim: Pick<BrowserClaim, "viewer" | "name">,
) =>
  fields(
    "ara/pair/phone-claim/v1",
    origin,
    i.id,
    i.phone,
    i.expires,
    claim.viewer,
    claim.name,
  );

export async function verifyClaim(i: PhoneInvitation, claim: BrowserClaim) {
  if (!validBrowserName(claim.name)) throw Error("Invalid browser name");
  const bytes = claimBytes(i.origin, i, claim);
  if (!equal(await grantMac(i.secret, bytes), fromHex(claim.mac, 32)))
    throw Error("Untrusted browser");
  await verifySignature(claim.viewer, bytes, claim.signature);
}

/** Structural parsing only. Expiry is compared with service time by the caller. */
export function decodePhoneInvitation(
  uri: string,
  expectedOrigin: string,
): PhoneInvitation {
  const url = new URL(uri);
  if (
    uri.length >= 4096 ||
    url.origin !== originURL(expectedOrigin) ||
    url.username ||
    url.password ||
    url.pathname !== "/control" ||
    url.search ||
    !url.hash
  )
    throw Error("Invalid phone code");
  const i = JSON.parse(
    new TextDecoder().decode(unb64(url.hash.slice(1))),
  ) as PhoneInvitation;
  if (
    i.v !== 1 ||
    i.origin !== expectedOrigin ||
    !Number.isSafeInteger(i.expires) ||
    i.expires <= 0
  )
    throw Error("Invalid phone code");
  fromHex(i.id, 16);
  fromHex(i.secret, 32);
  keyBytes(i.phone);
  return i;
}
export const encodePhoneInvitation = (i: PhoneInvitation) =>
  `${originURL(i.origin)}/control#${b64(utf8(JSON.stringify(i)))}`;

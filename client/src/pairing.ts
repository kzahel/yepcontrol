import { b64, type Identity } from "@remote/protocol";
import { type DeviceInfo, openDevice } from "@remote/protocol/device";
import {
  createBytes,
  fields,
  type Grant,
  grantBytes,
  grantMac,
  hex,
  type Invitation,
  keyBytes,
  validBrowserName,
  verifyOffer,
} from "@remote/protocol/enrollment";
import {
  claimBytes,
  decodePhoneInvitation,
  type PhoneInvitation,
} from "@remote/protocol/phone-invitation";
import { pairingApi } from "./pairing-request.js";

export async function createPairing(
  origin: string,
  identity: Identity,
  name: string,
  expires: number,
  signal?: AbortSignal,
): Promise<Invitation> {
  if (!validBrowserName(name)) throw new Error("Invalid client name");
  const invitation: Invitation = {
    v: 1,
    origin,
    id: hex(crypto.getRandomValues(new Uint8Array(16))),
    viewer: b64(identity.publicKey),
    secret: hex(crypto.getRandomValues(new Uint8Array(32))),
    expires,
    name,
  };
  await pairingApi(origin, signal).request(invitation.id, "", {
    viewer: invitation.viewer,
    expires,
    signature: b64(await identity.sign(createBytes(origin, invitation))),
  });
  return invitation;
}

/** A TV code supplies the entropy for the lookup ID and the end-to-end proof.
 * Relay metadata is provisional until acceptOffer authenticates it with the code.
 */
export async function resolvePhoneInvitation(
  origin: string,
  input: string,
  signal?: AbortSignal,
): Promise<PhoneInvitation> {
  if (input.startsWith("https://")) {
    try {
      return decodePhoneInvitation(input, origin);
    } catch {
      throw new Error("Invalid phone pairing code");
    }
  }
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(code))
    throw new Error("Invalid phone pairing code");
  const derive = async (purpose: string) =>
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        fields(`ara/pair/tv-code/${purpose}/v1`, origin, code),
      ),
    );
  const id = hex((await derive("id")).slice(0, 16));
  const { state, phone, expires } = await pairingApi(origin, signal).request(
    id,
  );
  if (
    state !== "inviting" ||
    !phone ||
    typeof expires !== "number" ||
    !Number.isSafeInteger(expires) ||
    expires <= 0
  )
    throw new Error("This TV code is unavailable. Show a new code on the TV.");
  keyBytes(phone);
  return {
    v: 1,
    origin,
    id,
    phone,
    expires,
    secret: hex(await derive("secret")),
  };
}

export async function phoneClaim(
  identity: Identity,
  invite: PhoneInvitation,
  name: string,
) {
  if (!validBrowserName(name)) throw new Error("Invalid client name");
  const claim = { viewer: b64(identity.publicKey), name };
  const bytes = claimBytes(invite.origin, invite, claim);
  return {
    ...claim,
    signature: b64(await identity.sign(bytes)),
    mac: hex(await grantMac(invite.secret, bytes)),
  };
}

/** Authenticate the offer and decrypt its device report before committing authority. */
export async function acceptOffer(
  identity: Identity,
  invitation: Invitation,
  grant: Grant,
  sealedDevice: string,
  now: number,
): Promise<{ grant: Grant; device: DeviceInfo }> {
  await verifyOffer(invitation, grant, now);
  const device = await openDevice(
    invitation.secret,
    invitation.id,
    sealedDevice,
  );
  const viewerSignature = b64(
    await identity.sign(grantBytes(invitation.origin, grant)),
  );
  return { grant: { ...grant, viewerSignature }, device };
}

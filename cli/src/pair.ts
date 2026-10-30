import { acceptOffer, createPairing, phoneClaim } from "@remote/client/pairing";
import {
  PairingRequestError,
  pairingApi,
  pairingDelay,
} from "@remote/client/pairing-request";
import {
  encodeInvitation,
  type Invitation,
  originURL,
} from "@remote/protocol/enrollment";
import { decodePhoneInvitation } from "@remote/protocol/phone-invitation";
import type { Store } from "./store.js";
export async function pair(
  store: Store,
  origin: string,
  name: string,
  signal: AbortSignal,
  show: (uri: string) => Promise<void>,
  uri?: string,
) {
  originURL(origin);
  const api = pairingApi(origin, signal);
  const time = await api.time();
  const received = performance.now(),
    now = () => time.serverTime + performance.now() - received;
  signal.throwIfAborted();
  let invitation: Invitation;
  if (uri) {
    const invite = (() => {
      try {
        return decodePhoneInvitation(uri, origin);
      } catch {
        throw new Error("Invalid phone pairing code");
      }
    })();
    if (
      invite.expires * 1000 <= now() ||
      invite.expires * 1000 > now() + 301000
    )
      throw new Error("This code expired");
    const claim = await phoneClaim(store.identity, invite, name);
    try {
      await api.request(invite.id, "claim", claim);
    } catch (error) {
      if (!(error instanceof PairingRequestError) || !error.temporary)
        throw error;
      const existing = await api.request(invite.id, "", undefined, {
        seen: "",
        signal,
      });
      if (
        !(
          (existing.claim?.viewer === claim.viewer &&
            existing.claim.mac === claim.mac) ||
          (existing.grant?.viewer === claim.viewer &&
            existing.grant.phone === invite.phone)
        )
      )
        throw error;
    }
    invitation = { ...invite, viewer: claim.viewer, name };
  } else {
    invitation = await createPairing(
      origin,
      store.identity,
      name,
      time.expires,
      signal,
    );
    signal.throwIfAborted();
    await show(encodeInvitation(invitation));
  }
  let seen = uri ? "claimed" : "waiting";
  while (now() < invitation.expires * 1000) {
    signal.throwIfAborted();
    let result: Awaited<ReturnType<typeof api.request>>;
    try {
      result = await api.request(invitation.id, "", undefined, {
        seen,
        signal,
      });
    } catch (error) {
      if (!(error instanceof PairingRequestError) || !error.temporary)
        throw error;
      await pairingDelay(
        Math.min(
          Math.max(1000, error.retryAfter),
          Math.max(0, invitation.expires * 1000 - now()),
        ),
        signal,
      );
      continue;
    }
    if (result.state === "offered" && result.grant) {
      if (
        uri &&
        result.grant.phone !== decodePhoneInvitation(uri, origin).phone
      )
        throw new Error("Phone identity changed");
      const accepted = await acceptOffer(
        store.identity,
        invitation,
        result.grant,
        result.device ?? "",
        now(),
      );
      signal.throwIfAborted();
      const phone = {
        id: accepted.grant.id,
        origin,
        ...accepted,
        confirmed: false,
      };
      // Keep the verified grant if the completion receipt is lost; do not silently re-pair.
      await store.remember(phone);
      try {
        const complete = await api.request(invitation.id, "complete", {
          viewerSignature: accepted.grant.viewerSignature,
        });
        if (complete.state !== "paired")
          throw new Error("Pairing not confirmed");
      } catch {
        throw new Error(
          "Pairing completion is uncertain. The verified grant was saved; try status and check the phone before pairing again.",
        );
      }
      await store.remember({ ...phone, confirmed: true });
      return phone;
    }
    seen = result.state;
    await pairingDelay(750, signal);
  }
  throw new Error("This pairing code expired; create a new code");
}

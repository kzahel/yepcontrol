import { acceptOffer, phoneClaim } from "@remote/client/pairing";
import { decodePhoneInvitation } from "@remote/protocol/phone-invitation";
import { useEffect, useState } from "react";
import { browserName } from "./browser-name.js";
import {
  PairingRequestError,
  pairingDelay,
  pairingRequest,
  pairingTime,
} from "./pairing-request.js";
import { browserIdentity, phoneURL, rememberPhone } from "./store.js";
import { ViewerHeading } from "./viewer-heading.js";

/** Capture before the saved-phone database resolves, and never retain a secret in history. */
function capture() {
  const uri = location.href;
  if (location.hash)
    history.replaceState(null, "", location.pathname + location.search);
  return uri;
}
const initial = location.pathname === "/control" ? capture() : "";

export function ReceivePhone() {
  const [uri, setURI] = useState(initial);
  const [status, setStatus] = useState("Connecting to phone…");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const changed = () => setURI(capture());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let completing = false;
    void (async () => {
      try {
        setStatus("Connecting to phone…");
        setBusy(true);
        const invite = decodePhoneInvitation(uri, location.origin);
        const time = await pairingTime();
        const received = performance.now();
        const now = () => time.serverTime + performance.now() - received;
        if (
          invite.expires * 1000 <= now() ||
          invite.expires * 1000 > now() + 301000
        )
          throw Error("This code expired.");
        const identity = await browserIdentity();
        const claim = await phoneClaim(identity, invite, browserName());
        const { signature, mac } = claim;
        if (abort.signal.aborted) return;
        try {
          await pairingRequest(invite.id, "claim", {
            ...claim,
            signature,
            mac,
          });
        } catch (error) {
          if (!(error instanceof PairingRequestError) || !error.temporary)
            throw error;
          const existing = await pairingRequest(invite.id, "", undefined, {
            seen: "",
            signal: abort.signal,
          });
          if (
            !(
              existing.claim?.viewer === claim.viewer &&
              existing.claim.mac === mac
            ) &&
            !(
              existing.grant?.viewer === claim.viewer &&
              existing.grant.phone === invite.phone
            )
          )
            throw error;
        }
        while (!abort.signal.aborted && now() < invite.expires * 1000) {
          let result: Awaited<ReturnType<typeof pairingRequest>>;
          try {
            result = await pairingRequest(invite.id, "", undefined, {
              seen: "claimed",
              signal: abort.signal,
            });
          } catch (error) {
            if (!(error instanceof PairingRequestError) || !error.temporary)
              throw error;
            await pairingDelay(
              Math.min(
                Math.max(1000, error.retryAfter),
                Math.max(0, invite.expires * 1000 - now()),
              ),
              abort.signal,
            );
            continue;
          }
          if (abort.signal.aborted) return;
          if (result.state === "offered" && result.grant) {
            const invitation = {
              ...invite,
              viewer: claim.viewer,
              name: claim.name,
            };
            const grant = result.grant;
            if (grant.phone !== invite.phone)
              throw Error("Phone identity changed.");
            const { grant: paired, device } = await acceptOffer(
              identity,
              invitation,
              grant,
              result.device ?? "",
              now(),
            );
            const viewerSignature = paired.viewerSignature;
            if (abort.signal.aborted) return;
            completing = true;
            const accepted = await pairingRequest(invite.id, "complete", {
              viewerSignature,
            });
            if (abort.signal.aborted) return;
            if (accepted.state !== "paired")
              throw Error("Pairing wasn’t confirmed.");
            const id = await rememberPhone(paired, device);
            if (!abort.signal.aborted)
              location.replace(`${phoneURL(id)}?connect=1`);
            return;
          }
          await pairingDelay(750, abort.signal);
        }
        if (!abort.signal.aborted) throw Error("This code expired.");
      } catch (error) {
        if (!abort.signal.aborted) {
          setBusy(false);
          setStatus(
            completing
              ? "Pairing wasn’t confirmed. Check the phone before trying again."
              : error instanceof PairingRequestError && error.status === 400
                ? "This code is unavailable. Show a new code on the phone."
                : error instanceof Error
                  ? error.message
                  : "Couldn’t connect.",
          );
        }
      }
    })();
    return () => abort.abort();
  }, [uri]);
  return (
    <main>
      <ViewerHeading name="Control a phone" status={status} />
      {busy && <progress aria-label="Connecting to phone" />}
      <a href="/phones">Your phones</a>
    </main>
  );
}

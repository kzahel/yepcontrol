import { b64 } from "@remote/protocol";
import { openDevice } from "@remote/protocol/device";
import {
  createBytes,
  encodeInvitation,
  type Grant,
  grantBytes,
  hex,
  type Invitation,
  verifyOffer,
} from "@remote/protocol/enrollment";
import { useCallback, useEffect, useState } from "react";
import { encode } from "uqr";
import { browserName } from "./browser-name.js";
import { browserIdentity, phoneURL, rememberPhone } from "./store.js";
import { ViewerHeading } from "./viewer-heading.js";

async function api(
  id: string,
  action = "",
  body?: unknown,
  wait?: { seen: string; signal: AbortSignal },
) {
  const response = await fetch(
    `/api/pair/${id}${action ? `/${action}` : ""}`,
    body === undefined
      ? wait
        ? // The relay holds this poll until the state differs from `seen`.
          { headers: { "Pair-Wait": wait.seen }, signal: wait.signal }
        : {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok)
    throw new Error("Pairing expired, revoked, or unavailable.");
  return response.json() as Promise<{
    state: string;
    grant?: Grant;
    device?: string;
  }>;
}
export function PairPhone() {
  const [invitation, setInvitation] = useState<Invitation>();
  const [status, setStatus] = useState("Creating a pairing code…");
  const [linkNotice, setLinkNotice] = useState("");
  const [showLink, setShowLink] = useState(false);
  const steps =
    "On the phone you want to control, open YepControl’s scanner, scan this code and tap Allow.";
  const [failure, setFailure] = useState<"code" | "unconfirmed">();
  const pair = useCallback(async () => {
    setFailure(undefined);
    setInvitation(undefined);
    setStatus("Creating a pairing code…");
    setLinkNotice("");
    setShowLink(false);
    try {
      const identity = await browserIdentity();
      const i: Invitation = {
        v: 1,
        origin: location.origin,
        id: hex(crypto.getRandomValues(new Uint8Array(16))),
        viewer: b64(identity.publicKey),
        secret: hex(crypto.getRandomValues(new Uint8Array(32))),
        expires: Math.floor(Date.now() / 1000) + 300,
        name: browserName(),
      };
      await api(i.id, "", {
        viewer: i.viewer,
        expires: i.expires,
        signature: b64(await identity.sign(createBytes(i.origin, i))),
      });
      setInvitation(i);
      setStatus("Waiting for approval on the phone you want to control");
    } catch (error) {
      setInvitation(undefined);
      setFailure("code");
      setStatus(error instanceof Error ? error.message : "Pairing failed");
    }
  }, []);
  // The code is the whole page; create it straight away.
  useEffect(() => {
    void pair();
  }, [pair]);
  useEffect(() => {
    if (!invitation) return;
    const abort = new AbortController();
    const stopped = () => abort.signal.aborted;
    // Renew while someone is looking; otherwise wait for them to return.
    const expired = () => {
      if (document.visibilityState === "visible") void pair();
      else {
        setInvitation(undefined);
        setFailure("code");
        setStatus("This code expired.");
      }
    };
    void (async () => {
      let seen = "waiting";
      let completionStarted = false;
      try {
        while (!stopped()) {
          if (Date.now() >= invitation.expires * 1000) {
            expired();
            return;
          }
          const asked = Date.now();
          const result = await api(invitation.id, "", undefined, {
            seen,
            signal: abort.signal,
          });
          if (result.state === "offered" && result.grant) {
            const g = result.grant;
            await verifyOffer(invitation, g);
            const device = await openDevice(
              invitation.secret,
              invitation.id,
              result.device ?? "",
            );
            const identity = await browserIdentity();
            const viewerSignature = b64(
              await identity.sign(grantBytes(invitation.origin, g)),
            );
            if (stopped()) return;
            completionStarted = true;
            const accepted = await api(invitation.id, "complete", {
              viewerSignature,
            });
            if (stopped()) return;
            if (accepted.state !== "paired") throw new Error("Pairing failed");
            const paired: Grant = { ...g, viewerSignature };
            const id = await rememberPhone(paired, device);
            location.assign(phoneURL(id));
            return;
          }
          seen = result.state;
          // A relay without held polls answers at once; keep the earlier pace.
          if (Date.now() - asked < 500)
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        if (stopped()) return;
        if (completionStarted) {
          setInvitation(undefined);
          setFailure("unconfirmed");
          setStatus("Pairing could not be confirmed.");
          return;
        }
        // A held poll can outlast the code; the relay then no longer knows it.
        if (Date.now() >= invitation.expires * 1000 - 1000) expired();
        else {
          setInvitation(undefined);
          setFailure("code");
          setStatus(error instanceof Error ? error.message : "Pairing failed");
        }
      }
    })();
    return () => abort.abort();
  }, [invitation, pair]);
  const qr = invitation
    ? encode(encodeInvitation(invitation), { ecc: "M" })
    : undefined;
  async function copyPairingLink(value: Invitation) {
    try {
      await navigator.clipboard.writeText(encodeInvitation(value));
      setLinkNotice(
        "Pairing link copied. Open it on the phone you want to control.",
      );
    } catch {
      setShowLink(true);
      setLinkNotice(
        "Copy this link and open it on the phone you want to control.",
      );
    }
  }
  return (
    <main>
      <ViewerHeading name="Control a phone" status={status} />
      <p className="pairing-role">
        This browser will control the phone. You do not need the Android app on
        this device.
      </p>
      {failure === "unconfirmed" && (
        <p role="alert">
          Check YepControl on the phone for an added browser before trying
          again.
        </p>
      )}
      {qr && invitation && (
        <section className="pairing-code" aria-label="Pairing code">
          <p>{steps}</p>
          <div className="pairing-link-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void copyPairingLink(invitation)}
            >
              Copy pairing link instead
            </button>
          </div>
          <p className="hint" aria-live="polite">
            {linkNotice}
          </p>
          {showLink && (
            <input
              className="pairing-link"
              aria-label="Pairing link"
              readOnly
              value={encodeInvitation(invitation)}
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
          <p className="hint">
            Only send this link to the phone’s owner. It expires with this code
            and still requires Allow on the phone.
          </p>
          <svg
            role="img"
            aria-label="Scan to pair this browser"
            viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`}
            width="360"
            height="360"
          >
            <title>Scan to pair this browser</title>
            <rect
              x="-4"
              y="-4"
              width={qr.size + 8}
              height={qr.size + 8}
              fill="white"
            />
            <path
              fill="black"
              d={qr.data
                .flatMap((row, y) =>
                  row.map((cell, x) => (cell ? `M${x},${y}h1v1h-1z` : "")),
                )
                .join("")}
            />
          </svg>

          <a
            href="https://play.google.com/store/apps/details?id=com.yepcontrol.app"
            rel="noreferrer"
          >
            Install YepControl on the phone being controlled
          </a>
          <p className="hint">A new code appears every five minutes.</p>
        </section>
      )}
      <p className="hint">
        Pairing adds access. Earlier pairings keep their access until you remove
        them in YepControl on the phone.
      </p>
      {failure && (
        <button type="button" onClick={() => void pair()}>
          New code
        </button>
      )}
    </main>
  );
}

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
  const steps =
    "Scan with your phone’s camera to open or install YepControl. Already installed? Open the app and tap Scan pairing code.";
  const [failure, setFailure] = useState<"code" | "unconfirmed">();
  const pair = useCallback(async () => {
    setFailure(undefined);
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
      setStatus("Scan this code with your phone");
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
  return (
    <main>
      <ViewerHeading name="Add phone" status={status} />
      <p className="hint">
        Pairing adds access. Earlier pairings keep their access until you remove
        them in Devices in YepControl on the phone.
      </p>
      {failure === "unconfirmed" && (
        <p role="alert">
          Check Devices in YepControl on the phone for an added entry before
          trying again.
        </p>
      )}
      {qr && invitation && (
        <section className="pairing-code" aria-label="Pairing code">
          <svg
            role="img"
            aria-label="Scan to pair this browser"
            viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`}
            width="360"
            height="360"
            shapeRendering="crispEdges"
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
          <p>{steps}</p>
          <a
            href="https://play.google.com/store/apps/details?id=com.yepcontrol.app"
            rel="noreferrer"
          >
            Get YepControl on Google Play
          </a>
          <p className="hint">A new code appears every five minutes.</p>
        </section>
      )}
      {failure && (
        <button type="button" onClick={() => void pair()}>
          New code
        </button>
      )}
    </main>
  );
}

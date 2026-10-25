import type { ControlState } from "@remote/protocol/control";
import type { DeviceInfo } from "@remote/protocol/device";
import type { PhoneFeatures } from "@remote/protocol/features";
import { useCallback, useEffect, useRef, useState } from "react";
import { RemoteSession } from "./control-session.js";
import { phoneLease } from "./phone-lease.js";
import { PhonePreview } from "./phone-preview.js";
import { encryptedCheck, prepareConnection } from "./relay.js";
import { RemoteScreen } from "./remote-screen.js";
import {
  browserIdentity,
  contactedPhone,
  forgetPhone,
  phoneName,
  type SavedPhone,
} from "./store.js";
import { ViewerHeading } from "./viewer-heading.js";
import { defaultScreenAspect } from "./viewer-workspace.js";
export const viewerServices = {
  connect: RemoteSession.connect,
  check: encryptedCheck,
  prepare: prepareConnection,
};
export type ViewerServices = typeof viewerServices;

export function PhonePage({
  phone,
  services,
}: {
  phone: SavedPhone;
  services: ViewerServices;
}) {
  // ViewerApp remounts this page for a different phone or pairing. Metadata
  // updates must not restart the automatic check or replace its connection.
  const [target] = useState(() => ({ id: phone.id, grant: phone.grant }));
  const metadata = useRef(phone);
  metadata.current = phone;
  const [status, setStatus] = useState("Checking connection…");
  const [pending, setPending] = useState<"check" | "control">();
  const [features, setFeatures] = useState<PhoneFeatures>();
  const [remote, setRemote] = useState<{
    session: RemoteSession;
    state: ControlState;
  }>();
  const [storageWarning, setStorageWarning] = useState("");
  const connection = useRef<AbortController | undefined>(undefined);
  const live = useRef<RemoteSession | undefined>(undefined);
  const release = useRef<(() => Promise<void>) | undefined>(undefined);
  const closing = useRef(Promise.resolve());
  const attempt = useRef<
    | {
        abort: AbortController;
        preparing: boolean;
        control: boolean;
        proceed: (() => void) | undefined;
      }
    | undefined
  >(undefined);
  const lastRecorded = useRef(0);
  const close = useCallback(() => {
    attempt.current = undefined;
    const abort = connection.current;
    connection.current = undefined;
    abort?.abort();
    live.current?.close();
    live.current = undefined;
    const released = release.current?.();
    release.current = undefined;
    closing.current = Promise.all([closing.current, released]).then(() => {});
    return closing.current;
  }, []);
  // Explicit connections are logged; state refreshes update details at most every 15 s.
  const recordContact = useCallback(
    (device: DeviceInfo, event?: string) => {
      if (!event && Date.now() - lastRecorded.current < 15000) return;
      lastRecorded.current = Date.now();
      void contactedPhone(target.id, device, event).catch(() =>
        setStorageWarning(
          "Connected, but contact history couldn’t be saved in this browser.",
        ),
      );
    },
    [target],
  );
  const disconnect = useCallback(() => {
    close();
    setRemote(undefined);
    setPending(undefined);
    setStatus("Disconnected");
  }, [close]);
  const start = useCallback(
    async (mode: "control" | "check") => {
      // Connect advances an existing preparation, even while it is still waking
      // the phone. Never abort it just to create a second wake request.
      const preparing = attempt.current;
      if (
        mode === "control" &&
        preparing?.preparing &&
        !preparing.abort.signal.aborted
      ) {
        preparing.control = true;
        preparing.proceed?.();
        setPending("control");
        setStatus("Connecting to your phone…");
        return;
      }
      const previous = close();
      const abort = new AbortController();
      connection.current = abort;
      const owned = {
        abort,
        preparing: mode === "check",
        control: mode === "control",
        proceed: undefined as (() => void) | undefined,
      };
      attempt.current = owned;
      setPending(mode);
      if (mode === "check") setFeatures(undefined);
      setStatus(
        mode === "check" ? "Checking connection…" : "Connecting to your phone…",
      );
      let ownedRelease: (() => Promise<void>) | undefined;
      let prepared: Awaited<ReturnType<ViewerServices["prepare"]>> | undefined;
      let connected = false;
      try {
        await previous;
        if (abort.signal.aborted) return;
        const lease = phoneLease(target.id, abort.signal);
        ownedRelease = () =>
          lease.then(
            (release) => release(),
            () => {},
          );
        release.current = ownedRelease;
        await lease;
        if (abort.signal.aborted) return;
        const identity = await browserIdentity();
        if (abort.signal.aborted) return;
        const report = (message: string) => {
          if (!abort.signal.aborted) setStatus(message);
        };
        if (mode === "check") {
          prepared = await services.prepare(
            identity,
            target.grant,
            report,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          setFeatures(prepared.features);
          recordContact(prepared.features.device, "Connection checked");
          if (!owned.control) {
            setStatus("Ready to connect");
            const { session, expiresAt } = prepared;
            const outcome = await new Promise<"connect" | "expired" | "closed">(
              (resolve) => {
                const timer = setTimeout(
                  () => finish("expired"),
                  Math.max(0, expiresAt - Date.now()),
                );
                const stopped = () => finish("closed");
                function finish(value: "connect" | "expired" | "closed") {
                  clearTimeout(timer);
                  abort.signal.removeEventListener("abort", stopped);
                  owned.proceed = undefined;
                  resolve(value);
                }
                owned.proceed = () => finish("connect");
                abort.signal.addEventListener("abort", stopped, { once: true });
                void session.closed.then(() => finish("closed"));
                if (abort.signal.aborted) stopped();
              },
            );
            if (abort.signal.aborted) return;
            if (outcome !== "connect") {
              setStatus(
                outcome === "expired"
                  ? "Connect when you’re ready"
                  : "Connection ended. Connect to try again.",
              );
              return;
            }
          }
        }
        if (abort.signal.aborted) return;
        owned.preparing = false;
        const result = await services.connect(
          identity,
          target.grant,
          report,
          abort.signal,
          prepared?.session,
        );
        if (abort.signal.aborted) {
          result.session.close();
          return;
        }
        connected = true;
        live.current = result.session;
        setRemote(result);
        recordContact(result.state.device, "Remote control started");
      } catch (error) {
        if (!abort.signal.aborted)
          setStatus(
            error instanceof Error ? error.message : "Connection failed",
          );
      } finally {
        if (!connected) {
          prepared?.session.close();
          await ownedRelease?.();
          if (release.current === ownedRelease) release.current = undefined;
        }
        if (attempt.current === owned) attempt.current = undefined;
        if (connection.current === abort && !abort.signal.aborted)
          setPending(undefined);
      }
    },
    [close, target, services, recordContact],
  );
  const removed = phone.access === "removed";
  useEffect(() => {
    if (!removed) return;
    close();
    setRemote(undefined);
    setPending(undefined);
  }, [removed, close]);
  useEffect(() => {
    // A removed pairing cannot connect again; don't contact the relay for it.
    if (metadata.current.access === "removed") return;
    // Installed 0.7.0 hosts end checks instead of retaining them. Until their
    // next authenticated report advertises preparation, use one explicit Connect.
    const prepare = () => {
      if (metadata.current.device.connectionPreparation === 1)
        void start("check");
      else setStatus("Connect when you’re ready");
    };
    prepare();
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setRemote(undefined);
        prepare();
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden" && attempt.current?.preparing) {
        close();
        setPending(undefined);
        setStatus("Connect when you’re ready");
      }
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", restored);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", close);
      window.removeEventListener("pageshow", restored);
      close();
    };
  }, [start, close]);
  if (removed)
    return (
      <main className="connected-viewer">
        <ViewerHeading
          name={phoneName(phone)}
          status="Access to this phone was removed on the phone."
        />
        <p>To add access, scan a new code and approve it on the phone.</p>
        <div className="phone-actions">
          <a className="button-link" href="/pair">
            Add access
          </a>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void forgetPhone(phone.id).then(() => location.assign("/"))
            }
          >
            Forget this phone
          </button>
        </div>
      </main>
    );
  return (
    <main className="connected-viewer">
      {remote ? (
        <RemoteScreen
          phoneId={phone.id}
          session={remote.session}
          initial={remote.state}
          name={phoneName(phone)}
          notice={storageWarning}
          aspect={defaultScreenAspect}
          onContact={(state) => recordContact(state.device)}
          onEnded={(message) => {
            close();
            setRemote(undefined);
            setPending(undefined);
            setStatus(message || "Connection ended");
          }}
          disconnect={disconnect}
        />
      ) : (
        <>
          <ViewerHeading
            name={phoneName(phone)}
            status={storageWarning || status}
          />
          <PhonePreview
            pending={pending}
            features={features}
            lastContactAt={phone.lastContactAt}
            connect={() => void start("control")}
            cancel={() => {
              close();
              setPending(undefined);
              setStatus("Connection cancelled");
            }}
          />
        </>
      )}
    </main>
  );
}

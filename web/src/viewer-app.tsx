import { type ReactNode, useEffect, useState } from "react";
import { AppShell } from "./app-shell.js";
import { PairPhone } from "./pair-phone.js";
import { PhoneDetails } from "./phone-details.js";
import { PhoneList } from "./phone-list.js";
import {
  PhonePage,
  type ViewerServices,
  viewerServices,
} from "./phone-page.js";
import { ReceivePhone } from "./receive-phone.js";
import {
  phoneName,
  type SavedPhone,
  savedPhones,
  watchPhones,
} from "./store.js";
import { ViewerHeading } from "./viewer-heading.js";

export function ViewerApp({
  services = viewerServices,
}: {
  services?: ViewerServices;
}) {
  const [phones, setPhones] = useState<SavedPhone[]>();
  const [error, setError] = useState("");
  const route = location.pathname;
  const [connectOnArrival] = useState(() => {
    const url = new URL(location.href);
    const connect =
      /^\/phones\/[a-f0-9]{64}$/.test(url.pathname) &&
      url.searchParams.get("connect") === "1";
    if (connect) {
      url.searchParams.delete("connect");
      history.replaceState(null, "", url.pathname + url.search);
    }
    return connect;
  });
  const match = /^\/phones\/([a-f0-9]{64})(\/details)?\/?$/.exec(route);
  const id = match?.[1];
  const details = !!match?.[2];
  const phone = phones?.find((entry) => entry.id === id);
  useEffect(() => {
    document.title = `${phone ? phoneName(phone) : route === "/pair" || route === "/control" ? "Control a phone" : "Your phones"} · YepControl`;
  }, [phone]);
  useEffect(() => {
    let stopped = false;
    let generation = 0;
    async function refresh() {
      const current = ++generation;
      try {
        const saved = await savedPhones();
        if (!stopped && current === generation) {
          setPhones(saved);
          setError("");
        }
      } catch {
        if (!stopped) {
          setPhones([]);
          setError(
            "Browser storage is unavailable. Close older tabs for this site, allow site storage, then reload.",
          );
        }
      }
    }
    const unsubscribe = watchPhones(() => {
      void refresh();
    });
    void refresh();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, []);
  let content: ReactNode;
  if (!phones)
    content = (
      <main>
        <ViewerHeading name="Your phones" status="Loading saved phones…" />
      </main>
    );
  else if (route === "/" || route === "/phones" || route === "/viewer.html")
    content = <PhoneList phones={phones} error={error} />;
  else if (route === "/pair" && !error) content = <PairPhone />;
  else if (route === "/control" && !error) content = <ReceivePhone />;
  else if (phone && !error && details) content = <PhoneDetails phone={phone} />;
  else if (phone && !error)
    content = (
      <PhonePage
        key={`${phone.id}:${phone.grant.id}`}
        phone={phone}
        services={services}
        autoConnect={connectOnArrival}
      />
    );
  else
    content = (
      <main>
        <ViewerHeading
          name={id ? "Phone not saved" : "Page unavailable"}
          status={
            error ||
            (id
              ? "This phone isn’t saved in this browser. Pair it to connect."
              : "Open your phones to continue.")
          }
        />
        {!error && (
          <a className="button-link" href="/pair">
            Control a phone
          </a>
        )}
      </main>
    );
  return (
    <AppShell phones={phones ?? []} current={phone}>
      {content}
    </AppShell>
  );
}

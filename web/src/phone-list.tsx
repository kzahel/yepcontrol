import { useEffect, useState } from "react";
import { ForgetPhone, PhoneName } from "./phone-management.js";
import {
  phoneDetailsURL,
  phoneName,
  phoneURL,
  refreshRemoved,
  type SavedPhone,
} from "./store.js";
import { ViewerHeading } from "./viewer-heading.js";

export function LastContact({ at }: { at: number | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  if (!at) return <span>Not contacted yet</span>;
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "always",
  });
  const relative =
    seconds < 60
      ? "just now"
      : seconds < 3600
        ? formatter.format(-Math.floor(seconds / 60), "minute")
        : seconds < 86400
          ? formatter.format(-Math.floor(seconds / 3600), "hour")
          : formatter.format(-Math.floor(seconds / 86400), "day");
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      Last contacted {relative}
    </time>
  );
}
export function PhoneList({
  phones,
  error,
}: {
  phones: SavedPhone[];
  error: string;
}) {
  const pairings = phones.map((phone) => phone.grant.id).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: recheck only when the set of pairings changes
  useEffect(() => {
    void refreshRemoved(phones);
  }, [pairings]);
  return (
    <main className="phone-library">
      <ViewerHeading
        name="Your phones"
        status={error || "Saved in this browser"}
      />
      <a className="button-link" href="/pair">
        Control a phone
      </a>
      {phones.length ? (
        <ul className="phone-list">
          {[...phones]
            .sort((a, b) => b.pairedAt - a.pairedAt || a.id.localeCompare(b.id))
            .map((phone) => (
              <li key={phone.id} className="phone-card">
                <div className="phone-description">
                  <PhoneName phone={phone}>
                    {/* Stretched over the card: the whole card opens the phone. */}
                    <a className="phone-title" href={phoneURL(phone.id)}>
                      {phoneName(phone)}
                    </a>
                  </PhoneName>
                  {/* One detail line, so renaming never changes the card's height. */}
                  <span className="phone-meta">
                    {`${phone.device.manufacturer} ${phone.device.model} · Android ${phone.device.android} · `}
                    {phone.access ? (
                      <span className="phone-access">
                        {phone.access === "removed"
                          ? "Access removed on the phone"
                          : "Access paused on the phone"}
                      </span>
                    ) : (
                      <LastContact at={phone.lastContactAt} />
                    )}
                  </span>
                </div>
                <div className="phone-actions">
                  <a
                    className="text-action"
                    href={phoneDetailsURL(phone.id)}
                    aria-label={`Details for ${phoneName(phone)}`}
                  >
                    Details
                  </a>
                  <ForgetPhone phone={phone} />
                </div>
              </li>
            ))}
        </ul>
      ) : (
        !error && (
          <p>
            This browser controls your saved phones. Choose Control a phone to
            pair one.
          </p>
        )
      )}
      <p className="hint">
        Phones and contact history are saved in this browser.
      </p>
    </main>
  );
}

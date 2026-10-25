import { type ReactNode, useEffect, useRef, useState } from "react";
import { ControlIcon } from "./control-icon.js";
import {
  forgetPhone,
  phoneName,
  renamePhone,
  type SavedPhone,
} from "./store.js";

/** The phone's name with an inline pencil edit. Blank restores the phone's own name. */
export function PhoneName({
  phone,
  children,
}: {
  phone: SavedPhone;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const name = phoneName(phone);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  async function save() {
    if (!editing) return;
    setEditing(false);
    if (value.trim() === (phone.alias ?? "")) return;
    try {
      await renamePhone(phone.id, value);
      setError("");
    } catch {
      setError("Couldn’t save the name. Check that site storage is available.");
    }
  }
  return (
    <div className="phone-name">
      {editing ? (
        <input
          ref={input}
          className="phone-name-input"
          aria-label="Phone name"
          value={value}
          placeholder={phone.device.name}
          maxLength={60}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <>
          {children}
          <button
            className="icon-button inline-action"
            type="button"
            aria-label={`Rename ${name}`}
            title="Rename"
            onClick={() => {
              setValue(phone.alias ?? "");
              setEditing(true);
            }}
          >
            <ControlIcon name="edit" />
          </button>
        </>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

/** Removes the phone from this browser after one confirmation. */
export function ForgetPhone({ phone }: { phone: SavedPhone }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const name = phoneName(phone);
  return (
    <>
      <button
        className="icon-button inline-action"
        type="button"
        aria-label={`Forget ${name}`}
        title="Forget"
        onClick={() => {
          setError("");
          dialog.current?.showModal();
        }}
      >
        <ControlIcon name="trash" />
      </button>
      <dialog ref={dialog} aria-label={`Forget ${name}?`}>
        <h2>Forget {name}?</h2>
        <p>
          This only removes the entry from this browser. To stop this browser’s
          access, remove its entries in YepControl on the phone.
        </p>
        <div className="dialog-actions">
          <button
            className="secondary"
            type="button"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              void forgetPhone(phone.id).then(
                () => dialog.current?.close(),
                () =>
                  setError(
                    "Couldn’t forget this phone. Check that site storage is available.",
                  ),
              )
            }
          >
            Forget
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </dialog>
    </>
  );
}

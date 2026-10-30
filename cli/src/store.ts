import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { b64, type Identity, identityFromKeys, unb64 } from "@remote/protocol";
import { type DeviceInfo, parseDevice } from "@remote/protocol/device";
import { type Grant, keyBytes, originURL } from "@remote/protocol/enrollment";
export interface Phone {
  id: string;
  origin: string;
  grant: Grant;
  device: DeviceInfo;
  confirmed: boolean;
}
interface State {
  v: 1;
  privateKey: string;
  publicKey: string;
  phones: Phone[];
}
export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const st = await lstat(directory);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    st.uid !== process.getuid?.()
  )
    throw new Error("CLI directory must be owned by you with mode 0700");
}
export async function privateRead(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o077 ||
      st.size > 1048576
    )
      throw new Error("CLI file must be owner-only and regular");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
/** Never follow or overwrite a destination supplied as an artifact path. */
export async function privateArtifact(
  file: string,
  bytes: string | Uint8Array,
) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
export class Store {
  private constructor(
    readonly directory: string,
    private state: State,
    readonly identity: Identity,
  ) {}
  static async load(directory: string) {
    await privateDirectory(directory);
    const lock = path.join(directory, ".store-lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new Error(
        "CLI identity store is busy; a previous interrupted store operation may need local recovery",
      );
    }
    try {
      const file = path.join(directory, "state.json");
      let state: State;
      try {
        state = JSON.parse(await privateRead(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Cannot read private CLI identity store");
        const pair = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"],
        );
        state = {
          v: 1,
          privateKey: b64(
            new Uint8Array(
              await crypto.subtle.exportKey("pkcs8", pair.privateKey),
            ),
          ),
          publicKey: b64(
            new Uint8Array(
              await crypto.subtle.exportKey("raw", pair.publicKey),
            ),
          ),
          phones: [],
        };
        await privateArtifact(file, JSON.stringify(state));
      }
      if (
        state.v !== 1 ||
        !Array.isArray(state.phones) ||
        state.phones.length > 100
      )
        throw new Error("Invalid CLI identity store");
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        unb64(state.privateKey),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const publicKey = await crypto.subtle.importKey(
        "raw",
        keyBytes(state.publicKey),
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      );
      const identity = await identityFromKeys({ privateKey, publicKey });
      const proof = new TextEncoder().encode("YepControl CLI identity check");
      if (
        !(await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          await identity.sign(proof),
          proof,
        ))
      )
        throw new Error("CLI identity mismatch");
      for (const phone of state.phones) {
        originURL(phone.origin);
        parseDevice(phone.device);
        if (
          phone.grant.viewer !== state.publicKey ||
          phone.id !== phone.grant.id
        )
          throw new Error("Invalid saved phone identity");
        keyBytes(phone.grant.phone);
      }
      return new Store(directory, state, identity);
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  phones() {
    return this.state.phones;
  }
  select(id?: string) {
    const phones = id
      ? this.state.phones.filter((p) => p.id === id || p.device.name === id)
      : this.state.phones;
    if (phones.length !== 1 || !phones[0])
      throw new Error("Select exactly one saved phone with --phone ID");
    return phones[0];
  }
  async remember(phone: Phone) {
    const lock = path.join(this.directory, ".store-lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new Error("CLI identity store is busy");
    }
    let temporary: string | undefined;
    try {
      const state: State = JSON.parse(
        await privateRead(path.join(this.directory, "state.json")),
      );
      if (state.publicKey !== this.state.publicKey)
        throw new Error("CLI identity changed");
      state.phones = [...state.phones.filter((p) => p.id !== phone.id), phone];
      if (state.phones.length > 100) throw new Error("Too many saved phones");
      temporary = path.join(this.directory, `.state-${crypto.randomUUID()}`);
      await privateArtifact(temporary, JSON.stringify(state));
      await rename(temporary, path.join(this.directory, "state.json"));
      this.state = state;
    } finally {
      if (temporary) await rm(temporary, { force: true });
      await rm(lock, { recursive: true });
    }
  }
}

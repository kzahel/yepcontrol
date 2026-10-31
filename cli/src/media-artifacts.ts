import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { MediaCliError, outputFailure } from "./media-errors.js";

export const MEDIA_BYTE_LIMIT = 64 * 1024 * 1024;
export const MEDIA_ARTIFACT_LIMIT = 100;

/** Reject existing destinations and symlinked parents before any sensor request. */
export async function mediaOutputPath(value: string) {
  if (!value || value === "-" || value.length > 4096 || value.includes("\0"))
    throw new MediaCliError(
      "MEDIA_INVALID_ARGUMENT",
      "Choose a valid local output path.",
    );
  const file = path.resolve(value),
    parent = path.dirname(file);
  try {
    const directory = await lstat(parent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (await realpath(parent)) !== parent
    )
      throw new MediaCliError(
        "MEDIA_UNSAFE_OUTPUT",
        "Use a real output directory without symlinks.",
      );
    // Protect the staging name and its ancestors against replacement by another
    // local user. A trusted sticky directory (for example the OS temp root) is safe.
    const uid = process.getuid?.();
    for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
      const entry = await lstat(ancestor);
      if (
        uid === undefined ||
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        (entry.uid !== uid && entry.uid !== 0) ||
        ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0)
      )
        throw new MediaCliError(
          "MEDIA_UNSAFE_OUTPUT",
          "Use an output directory whose path other users cannot replace.",
        );
      if (path.dirname(ancestor) === ancestor) break;
    }
    try {
      await lstat(file);
      throw new MediaCliError(
        "MEDIA_OUTPUT_EXISTS",
        "Output already exists. Choose a new path.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return file;
  } catch (error) {
    throw error instanceof MediaCliError ? error : outputFailure(error);
  }
}

/** A complete file becomes visible by exclusive hard link; rename never overwrites a destination. */
export class MediaFile {
  private closed = false;
  private committed = false;
  private disposing: Promise<void> | undefined;
  private constructor(
    readonly file: string,
    private readonly temporary: string,
    private readonly handle: FileHandle,
  ) {}
  static async create(value: string) {
    const file = await mediaOutputPath(value),
      temporary = path.join(
        path.dirname(file),
        `.yepcontrol-${crypto.randomUUID()}.partial`,
      );
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      return new MediaFile(file, temporary, handle);
    } catch (error) {
      throw outputFailure(error);
    }
  }
  async append(bytes: Uint8Array) {
    try {
      if (this.closed) throw Error("Closed output");
      await this.handle.writeFile(bytes);
    } catch (error) {
      throw outputFailure(error);
    }
  }
  async header(bytes: Uint8Array) {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = await this.handle.write(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!written.bytesWritten) throw Error("Short header write");
        offset += written.bytesWritten;
      }
    } catch (error) {
      throw outputFailure(error);
    }
  }
  async commit() {
    try {
      if (this.closed) throw Error("Closed output");
      await this.handle.sync();
      await this.handle.close();
      this.closed = true;
      await link(this.temporary, this.file);
      this.committed = true;
    } catch (error) {
      throw outputFailure(error);
    } finally {
      await this.dispose();
    }
    return this.file;
  }
  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      try {
        if (!this.closed) {
          this.closed = true;
          await this.handle.close();
        }
      } finally {
        await rm(this.temporary, { force: true });
      }
    })();
    return this.disposing;
  }
  get complete() {
    return this.committed;
  }
}
export async function mediaDirectory(value: string) {
  const directory = await mediaOutputPath(value);
  try {
    await mkdir(directory, { mode: 0o700 });
    return directory;
  } catch (error) {
    throw outputFailure(error);
  }
}
export async function removeEmptyMediaDirectory(directory: string) {
  try {
    await rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY")
      throw outputFailure(error);
  }
}
export function wavHeader(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % 2 || bytes > 1920000)
    throw new MediaCliError("MEDIA_LIMIT", "Invalid audio artifact size.");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

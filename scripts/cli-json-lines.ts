import type { Readable } from "node:stream";

/** Pipe chunks are neither JSON records nor UTF-8 boundaries. Never parse an unfinished reply. */
export function cliJsonLines(stream: Readable) {
  const records: Record<string, unknown>[] = [];
  let pending = "";
  let failure: Error | undefined;
  stream.setEncoding("utf8");
  const data = (chunk: string) => {
    if (failure) return;
    pending += chunk;
    let at = pending.indexOf("\n");
    while (at >= 0) {
      try {
        const value: unknown = JSON.parse(pending.slice(0, at));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("Invalid CLI JSON record");
        if (records.length >= 256) throw Error("Too many CLI fixture replies");
        records.push(value as Record<string, unknown>);
      } catch {
        failure = Error("Invalid CLI JSON record");
        return;
      }
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
    }
    if (pending.length > 2 * 1024 * 1024)
      failure = Error("CLI fixture reply exceeded its bound");
  };
  const end = () => {
    if (pending.length) failure = Error("Incomplete CLI JSON record");
  };
  const error = (value: Error) => {
    failure = value;
  };
  stream.on("data", data);
  stream.on("end", end);
  stream.on("error", error);
  return {
    read() {
      if (failure) throw failure;
      return records;
    },
    close() {
      stream.off("data", data);
      stream.off("end", end);
      stream.off("error", error);
    },
  };
}

import { once } from "node:events";

/** Bound backpressure and release the pipe on cancellation; never retry a reply. */
export async function output(value: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  try {
    if (!process.stdout.write(`${JSON.stringify(value)}\n`))
      await once(process.stdout, "drain", { signal: deadline });
    signal.throwIfAborted();
  } catch (error) {
    process.stdout.destroy();
    throw error;
  }
}

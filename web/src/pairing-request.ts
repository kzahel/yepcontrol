import type { Grant } from "@remote/protocol/enrollment";

export class PairingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter = 0,
  ) {
    super(message);
  }

  get temporary() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

async function request(url: string, options: RequestInit, creating: boolean) {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new PairingRequestError(
      "Can’t reach YepControl. Check this device’s internet connection and try again.",
      0,
    );
  }
  if (!response.ok) {
    let signatureRejected = false;
    if (creating && response.status === 400) {
      const detail = await response.json().catch(() => undefined);
      signatureRejected = detail?.error === "invalid-signature";
    }
    const retry = response.headers.get("Retry-After");
    const seconds = retry === null ? NaN : Number(retry);
    const retryAfter = Math.max(
      0,
      Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retry ?? "") -
            Date.parse(response.headers.get("Date") ?? "") || 0,
    );
    throw new PairingRequestError(
      response.status === 429
        ? "YepControl is receiving too many pairing requests. Wait before trying again."
        : response.status >= 500
          ? "YepControl’s pairing service is temporarily unavailable. Try again shortly."
          : !creating && (response.status === 404 || response.status === 410)
            ? "This pairing code is no longer available. Create a new code."
            : creating
              ? signatureRejected
                ? "Couldn’t create code (signature rejected)."
                : `Couldn’t create code (error ${response.status}).`
              : `YepControl couldn’t check this pairing code (error ${response.status}). Try a new code.`,
      response.status,
      retryAfter || (response.status === 429 ? 60000 : 0),
    );
  }
  return response;
}

export async function pairingTime(): Promise<{
  serverTime: number;
  expires: number;
}> {
  const response = await request(
    "/api/pairing-time",
    { cache: "no-store" },
    true,
  );
  const value = await response.json();
  if (
    !Number.isSafeInteger(value.serverTime) ||
    value.serverTime <= 0 ||
    !Number.isSafeInteger(value.expires) ||
    value.expires * 1000 <= value.serverTime ||
    value.expires * 1000 > value.serverTime + 300000
  )
    throw new Error("Couldn’t create code (invalid service deadline).");
  return { serverTime: value.serverTime, expires: value.expires };
}

export async function pairingRequest(
  id: string,
  action = "",
  body?: unknown,
  wait?: { seen: string; signal: AbortSignal },
) {
  const response = await request(
    `/api/pair/${id}${action ? `/${action}` : ""}`,
    body === undefined
      ? wait
        ? { headers: { "Pair-Wait": wait.seen }, signal: wait.signal }
        : {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
    body !== undefined && !action,
  );
  return response.json() as Promise<{
    state: string;
    grant?: Grant;
    device?: string;
  }>;
}

/** Stop both the timer and listener when leaving or replacing the QR page. */
export function pairingDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

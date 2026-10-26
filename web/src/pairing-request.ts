import type { Grant } from "@remote/protocol/enrollment";

export class PairingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter = 0,
    readonly serverTime: number | undefined = undefined,
  ) {
    super(message);
  }

  get temporary() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export async function pairingRequest(
  id: string,
  action = "",
  body?: unknown,
  wait?: { seen: string; signal: AbortSignal },
) {
  let response: Response;
  try {
    response = await fetch(
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
    );
  } catch (error) {
    if (wait?.signal.aborted) throw error;
    throw new PairingRequestError(
      "Can’t reach YepControl. Check this device’s internet connection and try again.",
      0,
    );
  }
  if (!response.ok) {
    const creating = body !== undefined && !action;
    let serverTime: number | undefined;
    let signatureRejected = false;
    if (creating && response.status === 400) {
      const detail = await response.json().catch(() => undefined);
      signatureRejected = detail?.error === "invalid-signature";
      if (
        detail?.error === "clock-skew" &&
        Number.isSafeInteger(detail.serverTime) &&
        detail.serverTime > 0
      )
        serverTime = detail.serverTime;
    }
    const retry = response.headers.get("Retry-After");
    const seconds = retry === null ? NaN : Number(retry);
    const retryAfter = Math.max(
      0,
      Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retry ?? "") - Date.now() || 0,
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
      serverTime,
    );
  }
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

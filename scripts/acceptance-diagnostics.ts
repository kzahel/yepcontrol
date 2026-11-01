// Public CI may report code locations, never raw fixture output, QR data or grants.
export function nativeFailure(message: string, output: string): Error {
  const frames = output.match(
    /^\s*at dev\.remoteaccess\.[A-Za-z0-9_.$]+\([A-Za-z0-9_.-]+:\d+\)\s*$/gm,
  );
  return new Error(
    `${message}\n${
      frames
        ?.slice(0, 8)
        .map((line) => line.trim())
        .join("\n") ??
      "No application stack locations; private fixture log retained"
    }`,
  );
}

// A corrupted/unexpected fixture file must never turn into a public log leak.
export function safeFixtureDiagnostics(
  raw: string,
): Record<string, boolean | number | string> | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, boolean | number | string> = {};
    for (const key of [
      "armed",
      "automatic",
      "notificationsAllowed",
      "fidPresent",
      "approvalVisible",
      "pairingFailureVisible",
      "cameraAllowed",
      "microphoneAllowed",
      "cameraPermission",
      "microphonePermission",
      "sensorPermissionButtonVisible",
    ]) {
      if (typeof parsed[key] !== "boolean") return undefined;
      result[key] = parsed[key];
    }
    for (const key of [
      "devices",
      "synced",
      "wakeReady",
      "registrationRunning",
      "registrationQueued",
    ]) {
      const value = parsed[key];
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 10000
      )
        return undefined;
      result[key] = value;
    }
    const state = parsed.wakeState;
    if (
      typeof state !== "string" ||
      ![
        "unset",
        "synchronized",
        "registration-unavailable",
        "sync-incomplete",
        "other",
      ].includes(state)
    )
      return undefined;
    result.wakeState = state;
    if (
      typeof parsed.pairingFailureKind !== "string" ||
      !["none", "network", "protocol", "other"].includes(
        parsed.pairingFailureKind,
      )
    )
      return undefined;
    result.pairingFailureKind = parsed.pairingFailureKind;
    return result;
  } catch {
    return undefined;
  }
}

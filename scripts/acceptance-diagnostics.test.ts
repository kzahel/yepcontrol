import { describe, expect, it } from "vitest";
import {
  nativeFailure,
  safeFixtureDiagnostics,
} from "./acceptance-diagnostics.js";

const valid = {
  armed: true,
  automatic: true,
  notificationsAllowed: true,
  fidPresent: false,
  approvalVisible: false,
  pairingFailureVisible: false,
  cameraAllowed: false,
  microphoneAllowed: false,
  cameraPermission: false,
  microphonePermission: false,
  sensorPermissionButtonVisible: false,
  pairingFailureKind: "none",
  devices: 1,
  synced: 1,
  wakeReady: 0,
  registrationRunning: 0,
  registrationQueued: 1,
  wakeState: "registration-unavailable",
};
describe("private fixture diagnostics in public CI", () => {
  it("emits only validated readiness values and discards private extra fields", () => {
    const result = safeFixtureDiagnostics(
      JSON.stringify({
        ...valid,
        fid: "never-log-this-address",
        pin: "never-log-this-value",
        authority: { secret: "never-log-this-grant" },
      }),
    );
    expect(result).toEqual(valid);
    expect(JSON.stringify(result)).not.toContain("never-log");
  });
  it("refuses arbitrary provider strings, malformed values and out-of-range counts", () => {
    for (const changed of [
      { wakeState: "secret provider response" },
      { pairingFailureKind: "secret provider response" },
      { automatic: "true" },
      { cameraPermission: "secret provider response" },
      { sensorPermissionButtonVisible: null },
      { devices: 10001 },
      { synced: -1 },
      { registrationRunning: null },
    ]) {
      expect(
        safeFixtureDiagnostics(JSON.stringify({ ...valid, ...changed })),
      ).toBeUndefined();
    }
    for (const raw of ["not JSON", "null", "[]"])
      expect(safeFixtureDiagnostics(raw)).toBeUndefined();
  });
  it("keeps only application stack locations from a native failure", () => {
    const error = nativeFailure(
      "Native test failed",
      "secret=never-log-this\n at dev.remoteaccess.app.HostedPairingTest.waitFor(HostedPairingTest.kt:44)\n at third.party.Client.call(Secret.java:18)",
    );
    expect(error.message).toContain("HostedPairingTest.kt:44");
    expect(error.message).not.toContain("never-log");
    expect(error.message).not.toContain("third.party");
  });
});

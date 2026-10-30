/** Recovery for the known temporary credential on an owned acceptance emulator. */
import { rm } from "node:fs/promises";
import path from "node:path";
export type LockFixture = { adb: (...args: string[]) => string; state: string };
export async function restoreSyntheticLock({ adb, state }: LockFixture) {
  if (adb("shell", "getprop", "ro.kernel.qemu") !== "1")
    throw new Error("Synthetic lock recovery requires an owned emulator");
  let cleared: string;
  try {
    cleared = adb("shell", "locksettings", "clear", "--old", "314159");
  } catch (error) {
    const failed = error as { stdout?: unknown; stderr?: unknown };
    const output = `${String(failed.stdout ?? "")}\n${String(failed.stderr ?? "")}`;
    if (!output.includes("Old password provided but user has no password"))
      throw error;
    cleared = output;
  }
  if (cleared.includes("Old password provided but user has no password")) {
    if (
      !adb("shell", "locksettings", "verify").includes(
        "Lock credential verified successfully",
      )
    )
      throw new Error("Could not verify an already-cleared synthetic lock");
  } else if (!cleared.includes("Lock credential cleared")) {
    throw new Error("Synthetic credential recovery failed; marker retained");
  }
  adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  const deadline = Date.now() + 15000;
  while (true) {
    adb("shell", "wm", "dismiss-keyguard");
    if (
      /KeyguardServiceDelegate[\s\S]*?\bshowing=false/.test(
        adb("shell", "dumpsys", "window", "policy"),
      )
    )
      break;
    if (Date.now() >= deadline)
      throw new Error(
        "Synthetic keyguard restoration timed out; marker retained",
      );
    await new Promise((r) => setTimeout(r, 250));
  }
  await rm(path.join(state, "synthetic-lock"), { force: true });
}

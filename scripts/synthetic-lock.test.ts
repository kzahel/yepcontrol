import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { restoreSyntheticLock } from "./synthetic-lock.js";

it.each([
  "installed",
  "not installed",
  "already cleared",
])("restores a %s synthetic credential and removes the marker last", async (stateCase) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "yep-lock-"));
  const marker = path.join(state, "synthetic-lock");
  await writeFile(marker, "owned");
  let verified = false,
    refreshed = false;
  try {
    await restoreSyntheticLock({
      state,
      adb: (...args) => {
        const command = args.join(" ");
        if (command.includes("ro.kernel.qemu")) return "1";
        if (command.includes("locksettings clear")) {
          if (stateCase === "already cleared")
            throw Object.assign(new Error("locksettings exit1"), {
              stdout: "Old password provided but user has no password",
            });
          return stateCase === "installed"
            ? "Lock credential cleared"
            : "Old password provided but user has no password";
        }
        if (command.includes("locksettings verify")) {
          verified = true;
          return "Lock credential verified successfully";
        }
        if (command.includes("dismiss-keyguard")) {
          refreshed = true;
          return "";
        }
        if (command.includes("dumpsys"))
          return "KeyguardServiceDelegate showing=false";
        return "";
      },
    });
    expect(verified).toBe(stateCase !== "installed");
    expect(refreshed).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
it.each([
  "mismatch",
  "wake failed",
])("retains the recovery obligation on %s", async (failure) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "yep-lock-"));
  const marker = path.join(state, "synthetic-lock");
  await writeFile(marker, "owned");
  try {
    await expect(
      restoreSyntheticLock({
        state,
        adb: (...args) => {
          const command = args.join(" ");
          if (command.includes("ro.kernel.qemu")) return "1";
          if (command.includes("locksettings clear"))
            return failure === "mismatch"
              ? "Old password did not match"
              : "Lock credential cleared";
          throw Error("Wake failed");
        },
      }),
    ).rejects.toThrow();
    expect(await readFile(marker, "utf8")).toBe("owned");
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

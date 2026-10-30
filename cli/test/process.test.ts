import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

it("cancels a blocked output pipe and runs teardown without replay", async () => {
  const child = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    "cli/test/fixtures/blocked.ts",
    "session",
    "--stdio",
  ]);
  const done = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  await once(child.stdout, "readable");
  child.stdout.read();
  child.stdin.write('{"id":"capture","op":"capture"}\n');
  await once(child.stdout, "readable");
  child.stdout.read(1);
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [code, signal] = await done;
    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(stderr).toContain("closed");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
});

it("reports argument failures as sanitized JSON on stderr", async () => {
  const child = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    "cli/src/main.ts",
    "--unknown-secret=private-value",
    "--json",
  ]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const [code] = await once(child, "exit");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toEqual({
    ok: false,
    error: { code: "CLI_ERROR", message: "Invalid arguments; use --help" },
  });
});

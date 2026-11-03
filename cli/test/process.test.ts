import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

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

async function blockedMedia(cancel: boolean) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "yep-media-pipe-")),
  );
  const child = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    "cli/test/fixtures/blocked-media.ts",
    "session",
    "--stdio",
    "--json",
  ]);
  const done = once(child, "exit");
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const kill = setTimeout(() => child.kill("SIGKILL"), 40000);
  try {
    await vi.waitFor(() => expect(stdout).toContain('"type":"ready"'), {
      timeout: 5000,
    });
    child.stdin.write(
      `${JSON.stringify({ id: "mic", op: "microphoneStart", out: path.join(directory, "audio.wav"), duration: "60s" })}\n`,
    );
    await vi.waitFor(() => expect(stdout).toContain('"id":"mic"'), {
      timeout: 5000,
    });
    child.stdout.pause();
    child.stdin.write('{"id":"block","op":"capture"}\n');
    await vi.waitFor(() => expect(stderr).toContain("large-reply"), {
      timeout: 5000,
    });
    await vi.waitFor(
      () => expect(child.stdout.readableLength).toBeGreaterThan(16384),
      { timeout: 5000 },
    );
    if (cancel) child.kill("SIGTERM");
    const [code, signal] = await done;
    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(stderr).toContain("sensor-stopped");
    expect(stderr).toContain("closed");
  } finally {
    clearTimeout(kill);
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}
it(
  "cancels a running microphone when stdout is blocked",
  () => blockedMedia(true),
  10000,
);
it(
  "automatically closes the media owner when an unread output pipe reaches its deadline",
  () => blockedMedia(false),
  45000,
);

it("does not disclose malformed private selector input in fatal errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yep-query-private-"));
  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      "cli/src/main.ts",
      "query",
      "--from-stdin",
      "--json",
    ],
    { env: { ...process.env, YEPCONTROL_HOME: directory } },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const done = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.stdin.end('{"name":"private-query-marker-that-must-not-be-logged"');
  try {
    const [code, signal] = await done;
    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("private-query-marker");
    expect(JSON.parse(stderr).error.message).toBe("Invalid UI selector JSON");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

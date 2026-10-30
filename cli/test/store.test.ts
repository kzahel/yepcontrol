import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { privateArtifact, Store } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
it("persists the identity privately and refuses loose permissions or symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yep-cli-store-"));
  directories.push(directory);
  const a = await Store.load(directory),
    b = await Store.load(directory);
  expect(b.identity.publicKey).toEqual(a.identity.publicKey);
  const file = path.join(directory, "state.json");
  expect((await stat(file)).mode & 0o077).toBe(0);
  await chmod(file, 0o644);
  await expect(Store.load(directory)).rejects.toThrow("Cannot read");
  await chmod(file, 0o600);
  const original = await readFile(file);
  await rm(file);
  await symlink(path.join(directory, "target.json"), file);
  await expect(Store.load(directory)).rejects.toThrow("Cannot read");
  await rm(file);
  await privateArtifact(file, original);
  await chmod(directory, 0o755);
  await expect(Store.load(directory)).rejects.toThrow("0700");
});
it("artifact output never overwrites an existing file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yep-cli-artifact-"));
  directories.push(directory);
  const file = path.join(directory, "image.jpg");
  await privateArtifact(file, "original");
  await expect(privateArtifact(file, "replacement")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("original");
});

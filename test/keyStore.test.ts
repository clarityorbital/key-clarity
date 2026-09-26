import { lstat, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { hashKey, KeyStore, maskKey, type SecretBackend } from "../src/keys/keyStore";
import { assertNoSymlinks, atomicWrite, backupOnce, BACKUP_SUFFIX } from "../src/targets/fsUtil";
import { workspaceKeyFile, writeKeyFile } from "../src/targets/keyFiles";

function memoryBackend(): SecretBackend & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    store: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

describe("KeyStore", () => {
  it("adds, dedupes, renames and removes keys", async () => {
    const store = new KeyStore(memoryBackend());
    const a = await store.add("  sk-aaaaaaaaaaaa  ", "alpha");
    expect(a.hash).toBe(hashKey("sk-aaaaaaaaaaaa"));
    await store.add("sk-aaaaaaaaaaaa", "alpha-renamed");
    await store.add("sk-bbbbbbbbbbbb", "beta");
    expect((await store.list()).map((k) => k.alias)).toEqual(["alpha-renamed", "beta"]);
    await store.rename(a.hash, "a2");
    await store.remove(hashKey("sk-bbbbbbbbbbbb"));
    expect((await store.list()).map((k) => k.alias)).toEqual(["a2"]);
  });

  it("does not lose concurrent additions", async () => {
    const store = new KeyStore(memoryBackend());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(`sk-key-number-${i}`, `k${i}`)));
    expect(await store.list()).toHaveLength(20);
  });

  it("rejects empty keys and masks for display", async () => {
    await expect(new KeyStore(memoryBackend()).add("   ", "x")).rejects.toThrow(/empty/);
    expect(maskKey("sk-1234567890abcd")).toBe("sk-...abcd");
  });
});

describe("files", () => {
  it("writes key files with 0600 inside a 0700 directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "kc-"));
    process.env.KEY_CLARITY_HOME = path.join(home, ".key-clarity");
    const file = workspaceKeyFile("/work/my project");
    expect(path.basename(file)).toMatch(/^my_project-[0-9a-f]{12}\.key$/);
    await writeKeyFile(file, "sk-secret");
    expect(await readFile(file, "utf8")).toBe("sk-secret\n");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(process.env.KEY_CLARITY_HOME)).mode & 0o777).toBe(0o700);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    delete process.env.KEY_CLARITY_HOME;
  });

  it("writes through a symlinked config instead of replacing the link", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kc-"));
    const real = path.join(dir, "dotfiles-settings.json");
    const link = path.join(dir, "settings.json");
    await writeFile(real, "old");
    await symlink(real, link);
    await atomicWrite(link, "new");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("new");
    await expect(assertNoSymlinks([path.join(dir, "missing"), real])).resolves.toBeUndefined();
    await expect(assertNoSymlinks([link])).rejects.toThrow(/symbolic link/);
  });

  it("backs up once and keeps file modes on rewrite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kc-"));
    const file = path.join(dir, "settings.json");
    expect(await backupOnce(file)).toBeUndefined();
    await atomicWrite(file, "original", 0o640);
    expect(await backupOnce(file)).toBe(file + BACKUP_SUFFIX);
    await atomicWrite(file, "changed");
    expect(await backupOnce(file)).toBeUndefined();
    expect(await readFile(file + BACKUP_SUFFIX, "utf8")).toBe("original");
    expect(await readFile(file, "utf8")).toBe("changed");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o640);
  });
});

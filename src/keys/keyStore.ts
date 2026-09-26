import { createHash } from "node:crypto";

/** The subset of `vscode.SecretStorage` the store needs, so tests can pass a Map-backed fake. */
export interface SecretBackend {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface HeldKey {
  /** sha256 hex of the secret: the id LiteLLM uses for the key. */
  hash: string;
  alias: string;
  secret: string;
  addedAt: string;
}

const STORAGE_KEY = "keyClarity.keys";
const ACCOUNT_KEY = "keyClarity.accountKey";

export function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Masks a secret for display: `sk-...AbCd`. */
export function maskKey(secret: string): string {
  if (secret.length <= 10) return "•".repeat(secret.length);
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

/** Keys whose secrets this machine holds, kept in secret storage as one JSON list. */
export class KeyStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly backend: SecretBackend) {}

  async list(): Promise<HeldKey[]> {
    const raw = await this.backend.get(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isHeldKey) : [];
    } catch {
      return [];
    }
  }

  async get(hash: string): Promise<HeldKey | undefined> {
    return (await this.list()).find((k) => k.hash === hash);
  }

  /** Adds a key, or renames it if it is already held. Returns the stored entry. */
  add(secret: string, alias: string): Promise<HeldKey> {
    const trimmed = secret.trim();
    if (!trimmed) return Promise.reject(new Error("The key is empty."));
    return this.mutate((keys) => {
      const hash = hashKey(trimmed);
      const existing = keys.find((k) => k.hash === hash);
      if (existing) {
        existing.alias = alias;
        return existing;
      }
      const entry: HeldKey = { hash, alias, secret: trimmed, addedAt: new Date().toISOString() };
      keys.push(entry);
      return entry;
    });
  }

  rename(hash: string, alias: string): Promise<void> {
    return this.mutate((keys) => {
      const entry = keys.find((k) => k.hash === hash);
      if (entry) entry.alias = alias;
    });
  }

  remove(hash: string): Promise<void> {
    return this.mutate((keys) => {
      const index = keys.findIndex((k) => k.hash === hash);
      if (index >= 0) keys.splice(index, 1);
    });
  }

  /** Optional separate key used for listing and generating keys. */
  async getAccountKey(): Promise<string | undefined> {
    return (await this.backend.get(ACCOUNT_KEY)) || undefined;
  }

  async setAccountKey(secret: string | undefined): Promise<void> {
    if (secret) await this.backend.store(ACCOUNT_KEY, secret.trim());
    else await this.backend.delete(ACCOUNT_KEY);
  }

  /** Serializes read-modify-write cycles so concurrent commands don't drop each other's changes. */
  private mutate<T>(fn: (keys: HeldKey[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const keys = await this.list();
      const result = fn(keys);
      await this.backend.store(STORAGE_KEY, JSON.stringify(keys));
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function isHeldKey(value: unknown): value is HeldKey {
  const v = value as HeldKey;
  return !!v && typeof v.hash === "string" && typeof v.secret === "string" && typeof v.alias === "string";
}

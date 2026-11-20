import { hashKey, maskKey } from "../keys/keyStore";
import { isForbidden, ProxyError, type KeyInfo, type LiteLLMClient } from "./client";

export interface KeyStatus {
  info?: KeyInfo;
  /** The key works, but the proxy limits it to model calls, so it can't read its own spend. */
  limited?: { models: string[] };
  error?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Spend and budget for a key. Proxies often limit keys to model calls (`llm_api_routes`),
 * which blocks `/key/info`. Then an account key with key-management access is tried, and
 * failing that, `/v1/models` confirms the key still works.
 */
export async function fetchKeyStatus(client: LiteLLMClient, secret: string, accountKey?: string): Promise<KeyStatus> {
  try {
    return { info: await client.keyInfo(secret) };
  } catch (err) {
    if (!isForbidden(err)) return { error: message(err) };
  }
  if (accountKey && accountKey !== secret) {
    try {
      return { info: await client.keyInfo(accountKey, hashKey(secret)) };
    } catch {
      // The account key can't read it either; fall back to a model listing.
    }
  }
  try {
    return { limited: { models: await client.listModels(secret) } };
  } catch (err) {
    return { error: message(err) };
  }
}

/** The proxy doesn't recognize the key: deleted, regenerated, mistyped, or from another proxy. */
export function isRejected(err: unknown): boolean {
  return err instanceof ProxyError && err.status === 401;
}

/**
 * The first key that can read key info. Failing that, the first key the proxy didn't reject, such as
 * one limited to model calls. A rejected key is never picked: every call with it would fail. When the
 * proxy can't be reached, the first key not yet rejected is kept, as nothing more can be learned.
 */
export async function pickAccountKey(client: LiteLLMClient, secrets: string[]): Promise<string | undefined> {
  const rejected = new Set<string>();
  for (const secret of secrets) {
    try {
      await client.keyInfo(secret);
      return secret;
    } catch (err) {
      // Unreachable proxy: trying the other keys would only wait out more timeouts.
      if (err instanceof ProxyError && err.status === null) break;
      if (isRejected(err)) rejected.add(secret);
    }
  }
  return secrets.find((s) => !rejected.has(s));
}

export type RejectedKey = { kind: "account"; secret: string } | { kind: "held"; alias: string; secret: string } | { kind: "none" };

/** What to tell the user when the proxy rejects the key used to read usage. */
export function rejectedKeyMessage(key: RejectedKey): string {
  const why = "It may have been deleted or regenerated, or it was made on a different proxy.";
  switch (key.kind) {
    case "account":
      return `The proxy doesn't recognize your account key (${maskKey(key.secret)}). ${why} Run Key Clarity: Set Account Key with a current key, or leave it empty to use your other keys.`;
    case "held":
      return `The proxy doesn't recognize the key "${key.alias}" (${maskKey(key.secret)}). ${why} Remove it with Key Clarity: Remove from Key Clarity and add a current key.`;
    case "none":
      return `The proxy doesn't recognize any of your keys. ${why} Check the proxy URL, then add a current key.`;
  }
}

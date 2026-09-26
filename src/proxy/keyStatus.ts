import { hashKey } from "../keys/keyStore";
import { isForbidden, type KeyInfo, type LiteLLMClient } from "./client";

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

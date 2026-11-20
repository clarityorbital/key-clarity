import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashKey } from "../src/keys/keyStore";
import { LiteLLMClient } from "../src/proxy/client";
import { fetchKeyStatus, pickAccountKey, rejectedKeyMessage } from "../src/proxy/keyStatus";
import { startMockProxy, type MockProxy } from "./mockProxy";

let proxy: MockProxy;
let client: LiteLLMClient;
const limited = { allowed_routes: ["llm_api_routes"], models: ["gpt-6-sol"] };

beforeAll(async () => {
  proxy = await startMockProxy();
  client = new LiteLLMClient(proxy.url);
});
afterAll(() => proxy.close());

describe("fetchKeyStatus", () => {
  it("reads a normal key's own info", async () => {
    const secret = proxy.seed("normal", "u1", { spend: 3, max_budget: 10 });
    expect(await fetchKeyStatus(client, secret)).toMatchObject({ info: { spend: 3, maxBudget: 10 } });
  });

  it("treats a key limited to model calls as working, with its models", async () => {
    const secret = proxy.seed("model-calls-only", "u2", limited);
    await expect(client.keyInfo(secret)).rejects.toThrow(/Only allowed to call routes: \('llm_api_routes'\)/);
    expect(await fetchKeyStatus(client, secret)).toEqual({ limited: { models: ["gpt-6-sol"] } });
  });

  it("reads a limited key's spend through an account key with key-management access", async () => {
    const account = proxy.seed("account", "u3");
    const secret = proxy.seed("model-calls-only", "u3", { ...limited, spend: 7.5 });
    expect(await fetchKeyStatus(client, secret, account)).toMatchObject({ info: { spend: 7.5, alias: "model-calls-only" } });
    expect(await client.keyInfo(account, hashKey(secret))).toMatchObject({ spend: 7.5 });
  });

  it("falls back to the model list when the account key is limited too", async () => {
    const account = proxy.seed("account-limited", "u4", limited);
    const secret = proxy.seed("model-calls-only", "u4", limited);
    expect(await fetchKeyStatus(client, secret, account)).toEqual({ limited: { models: ["gpt-6-sol"] } });
  });

  it("reports an invalid key as an error", async () => {
    const status = await fetchKeyStatus(client, "sk-not-a-real-key-000");
    expect(status.error).toMatch(/401/);
  });
});

describe("pickAccountKey", () => {
  const dead = "sk-deleted-or-regenerated-0000";

  it("picks the first key that can read key info", async () => {
    const limitedKey = proxy.seed("model-calls-only", "u5", limited);
    const full = proxy.seed("full", "u5");
    expect(await pickAccountKey(client, [limitedKey, full])).toBe(full);
  });

  it("never falls back to a key the proxy rejects", async () => {
    const limitedKey = proxy.seed("model-calls-only", "u6", limited);
    expect(await pickAccountKey(client, [dead, limitedKey])).toBe(limitedKey);
  });

  it("returns nothing when the proxy rejects every key", async () => {
    expect(await pickAccountKey(client, [dead])).toBeUndefined();
    expect(await pickAccountKey(client, [])).toBeUndefined();
  });

  it("keeps the first key when the proxy can't be reached", async () => {
    const offline = new LiteLLMClient("http://127.0.0.1:1", fetch, 500);
    expect(await pickAccountKey(offline, ["sk-a-000000000", "sk-b-000000000"])).toBe("sk-a-000000000");
  });
});

describe("rejectedKeyMessage", () => {
  it("names an explicit account key and how to replace it", () => {
    const msg = rejectedKeyMessage({ kind: "account", secret: "sk-abcdefghIGuA" });
    expect(msg).toContain("sk-...IGuA");
    expect(msg).toMatch(/Set Account Key/);
  });

  it("says every held key was rejected", () => {
    expect(rejectedKeyMessage({ kind: "none" })).toMatch(/doesn't recognize any of your keys/);
  });
});

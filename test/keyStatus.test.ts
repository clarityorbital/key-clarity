import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashKey } from "../src/keys/keyStore";
import { LiteLLMClient } from "../src/proxy/client";
import { fetchKeyStatus } from "../src/proxy/keyStatus";
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
    await expect(client.keyInfo(secret)).rejects.toThrow(/Only allowed to call routes: \['llm_api_routes'\]/);
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

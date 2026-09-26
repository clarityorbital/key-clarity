import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiteLLMClient, normalizeBaseUrl, ProxyError } from "../src/proxy/client";
import { hashKey } from "../src/keys/keyStore";
import { startMockProxy, type MockProxy } from "./mockProxy";

let proxy: MockProxy;
let client: LiteLLMClient;

beforeAll(async () => {
  proxy = await startMockProxy();
  client = new LiteLLMClient(proxy.url + "/v1/");
});
afterAll(() => proxy.close());

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and /v1", () => {
    expect(normalizeBaseUrl("https://llm.example.com/v1/")).toBe("https://llm.example.com");
    expect(normalizeBaseUrl(" https://llm.example.com/proxy// ")).toBe("https://llm.example.com/proxy");
  });
  it("rejects other protocols", () => {
    expect(() => normalizeBaseUrl("ftp://x.example.com")).toThrow(/Unsupported protocol/);
    expect(() => normalizeBaseUrl("not a url")).toThrow();
  });
});

describe("LiteLLMClient", () => {
  it("reads a key's own info with the key as bearer", async () => {
    const secret = proxy.seed("alpha", "user-1", { spend: 12.4, max_budget: 50, models: ["gpt-5.6-terra"] });
    const info = await client.keyInfo(secret);
    expect(info).toMatchObject({ alias: "alpha", spend: 12.4, maxBudget: 50, models: ["gpt-5.6-terra"], userId: "user-1" });
  });

  it("lists the user's keys with hashes that match sha256 of the secret", async () => {
    const secret = proxy.seed("beta", "user-2");
    proxy.seed("gamma", "user-2");
    proxy.seed("other-user", "user-3");
    const keys = await client.listKeys(secret, "user-2");
    expect(keys.map((k) => k.alias).sort()).toEqual(["beta", "gamma"]);
    expect(keys.find((k) => k.alias === "beta")?.hash).toBe(hashKey(secret));
  });

  it("generates, renames and deletes a key", async () => {
    const account = proxy.seed("account", "user-4");
    const created = await client.generateKey(account, { alias: "new-one", models: ["gpt-6-sol"], maxBudget: 20, duration: "30d" });
    expect(created.key).toMatch(/^sk-/);
    expect(created.alias).toBe("new-one");
    expect((await client.keyInfo(created.key)).maxBudget).toBe(20);

    await client.updateAlias(account, hashKey(created.key), "renamed");
    expect((await client.keyInfo(created.key)).alias).toBe("renamed");

    await client.deleteKeys(account, [hashKey(created.key)]);
    await expect(client.keyInfo(created.key)).rejects.toMatchObject({ status: 401 });
  });

  it("lists models the key may call", async () => {
    const secret = proxy.seed("models", "user-5", { models: ["gpt-6-sol", "claude-sonnet-5"] });
    expect(await client.listModels(secret)).toEqual(["claude-sonnet-5", "gpt-6-sol"]);
  });

  it("surfaces LiteLLM error messages", async () => {
    const err = await client.keyInfo("sk-not-a-real-key").catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect(err.message).toContain("Invalid proxy server token");
    const secret = proxy.seed("nosy", "user-6");
    await expect(client.listKeys(secret, "user-1")).rejects.toThrow(/Only admins/);
  });

  it("reports unreachable proxies clearly", async () => {
    const dead = new LiteLLMClient("http://127.0.0.1:9", fetch, 2000);
    await expect(dead.health()).rejects.toThrow(/Could not reach/);
  });
});

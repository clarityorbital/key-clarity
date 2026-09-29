import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { displaySafe, isInsecureRemote, LiteLLMClient, normalizeBaseUrl, ProxyError } from "../src/proxy/client";
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
  it("keeps only origin and path", () => {
    expect(normalizeBaseUrl("https://llm.example.com/proxy/v1?x=1#frag")).toBe("https://llm.example.com/proxy");
    expect(() => normalizeBaseUrl("https://user:pw@llm.example.com")).toThrow(/user name and password/);
  });

  it("flags plain http to remote hosts only", () => {
    expect(isInsecureRemote("http://llm.example.com")).toBe(true);
    expect(isInsecureRemote("https://llm.example.com")).toBe(false);
    expect(isInsecureRemote("http://localhost:4000")).toBe(false);
    expect(isInsecureRemote("http://127.0.0.1:4000")).toBe(false);
  });

  it("rejects other protocols", () => {
    expect(() => normalizeBaseUrl("ftp://x.example.com")).toThrow(/Unsupported protocol/);
    expect(() => normalizeBaseUrl("not a url")).toThrow();
  });
});

describe("displaySafe", () => {
  it("neutralizes notification links and caps length", () => {
    expect(displaySafe("click [here](command:workbench.action.terminal.sendSequence)")).toBe("click (here)(command:workbench.action.terminal.sendSequence)");
    expect(displaySafe("a\n\n  b")).toBe("a b");
    expect(displaySafe("x".repeat(500))).toHaveLength(200);
  });
});

describe("LiteLLMClient", () => {
  it("reads a key's own info with the key as bearer", async () => {
    const secret = proxy.seed("alpha", "user-1", { spend: 12.4, max_budget: 50, models: ["gpt-5.6-terra"] });
    const info = await client.keyInfo(secret);
    expect(info).toMatchObject({ alias: "alpha", spend: 12.4, maxBudget: 50, models: ["gpt-5.6-terra"], userId: "user-1" });
  });

  it("reads a key's own monthly budget", async () => {
    const secret = proxy.seed("monthly", "user-1", { max_budget: 200, budget_duration: "1mo", budget_reset_at: "2026-10-01T00:00:00Z" });
    expect(await client.keyInfo(secret)).toMatchObject({ maxBudget: 200, budgetDuration: "1mo", budgetResetAt: "2026-10-01T00:00:00Z" });
  });

  it("takes the budget and period from a linked budget tier when the key has none", async () => {
    const tier = { max_budget: 200, budget_duration: "1mo", budget_reset_at: "2026-10-01T00:00:00Z" };
    const onTier = proxy.seed("on-tier", "user-1", { litellm_budget_table: tier });
    expect(await client.keyInfo(onTier)).toMatchObject({ maxBudget: 200, budgetDuration: "1mo", budgetResetAt: tier.budget_reset_at });
    // The key's own limit wins over the tier's, and still resets on the tier's schedule.
    const override = proxy.seed("override", "user-1", { max_budget: 500, litellm_budget_table: tier });
    expect(await client.keyInfo(override)).toMatchObject({ maxBudget: 500, budgetDuration: "1mo" });
    // A total budget with no tier never resets.
    const total = proxy.seed("total", "user-1", { max_budget: 500 });
    expect(await client.keyInfo(total)).toMatchObject({ maxBudget: 500, budgetDuration: null, budgetResetAt: null });
  });

  it("reads the user's and teams' budgets", async () => {
    const secret = proxy.seed("owner", "user-7", { team_id: "team-a" });
    proxy.users.set("user-7", { spend: 150, max_budget: 200, budget_duration: "1mo", budget_reset_at: "2026-10-01T00:00:00Z" });
    proxy.teams.set("team-a", {
      team_alias: "research",
      members: ["user-7", "user-8"],
      spend: 900,
      max_budget: 1000,
      budget_duration: null,
      member_budgets: {
        "user-7": { spend: 42, max_budget: 200, budget_duration: "1mo", budget_reset_at: "2026-10-01T00:00:00Z" },
        "user-8": { spend: 1, max_budget: 5 },
      },
    });
    proxy.teams.set("team-b", { team_alias: "other", members: ["user-8"], spend: 0, max_budget: 5 });
    expect(await client.keyInfo(secret)).toMatchObject({ userId: "user-7", teamId: "team-a" });
    expect(await client.ownerBudgets(secret)).toEqual({
      userId: "user-7",
      user: { spend: 150, maxBudget: 200, budgetDuration: "1mo", budgetResetAt: "2026-10-01T00:00:00Z" },
      teams: [
        {
          id: "team-a",
          alias: "research",
          spend: 900,
          maxBudget: 1000,
          budgetDuration: null,
          budgetResetAt: null,
          member: { spend: 42, maxBudget: 200, budgetDuration: "1mo", budgetResetAt: "2026-10-01T00:00:00Z" },
        },
      ],
    });
  });

  it("reads a user without a budget row", async () => {
    const secret = proxy.seed("no-user-row", "user-9");
    expect(await client.ownerBudgets(secret)).toEqual({ userId: "user-9", user: null, teams: [] });
  });

  it("reads budget windows and a key's spend over a date range", async () => {
    const windows = [
      { budget_duration: "30d", max_budget: 200, reset_at: "2026-10-01T00:00:00+00:00" },
      { budget_duration: "24h", max_budget: 20, reset_at: "2026-09-29T00:00:00+00:00" },
    ];
    const secret = proxy.seed("windowed", "user-10", { spend: 900, budget_limits: JSON.stringify(windows) });
    expect((await client.keyInfo(secret)).budgetWindows).toEqual([
      { maxBudget: 200, budgetDuration: "30d", resetAt: "2026-10-01T00:00:00+00:00", spend: null },
      { maxBudget: 20, budgetDuration: "24h", resetAt: "2026-09-29T00:00:00+00:00", spend: null },
    ]);
    const hash = hashKey(secret);
    proxy.dailySpend.push(
      { date: "2026-08-31", api_key: hash, user_id: "user-10", spend: 500 },
      { date: "2026-09-01", api_key: hash, user_id: "user-10", spend: 30 },
      { date: "2026-09-28", api_key: hash, user_id: "user-10", spend: 12 },
      { date: "2026-09-28", api_key: "another-key", user_id: "user-10", spend: 7 },
    );
    expect(await client.keySpend(secret, hash, "2026-09-01", "2026-09-28")).toBe(42);
    // The aggregated route is admin-only, so it isn't used.
    expect(proxy.requests.some((r) => r.path === "/user/daily/activity/aggregated")).toBe(false);
    // Another user's key sees none of it: the proxy scopes spend to the caller's user.
    expect(await client.keySpend(proxy.seed("stranger", "user-11"), hash, "2026-09-01", "2026-09-28")).toBe(0);
  });

  it("reads budget windows returned as a list, as a 1.93 proxy returns them", async () => {
    const secret = proxy.seed("listed", "user-13", {
      spend: 300,
      budget_limits: [{ reset_at: "2026-10-01T00:00:00+00:00", max_budget: 150.0, budget_duration: "30d" }],
    });
    const info = await client.keyInfo(secret);
    expect(info).toMatchObject({ maxBudget: null, budgetDuration: null });
    expect(info.budgetWindows).toEqual([{ maxBudget: 150, budgetDuration: "30d", resetAt: "2026-10-01T00:00:00+00:00", spend: null }]);
  });

  it("adds up a key's spend across pages of daily activity", async () => {
    const secret = proxy.seed("busy", "user-12");
    const hash = hashKey(secret);
    // 2,500 rows: three pages of 1,000, whose totals the proxy reports per page.
    for (let i = 0; i < 2500; i++) proxy.dailySpend.push({ date: "2026-09-15", api_key: hash, user_id: "user-12", spend: 0.5 });
    expect(await client.keySpend(secret, hash, "2026-09-01", "2026-09-28")).toBe(1250);
    await expect(
      fetch(`${proxy.url}/user/daily/activity/aggregated?start_date=2026-09-01&end_date=2026-09-28`, { headers: { Authorization: `Bearer ${secret}` } }).then((r) => r.status),
    ).resolves.toBe(403);
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
    const created = await client.generateKey(account, {
      alias: "new-one",
      models: ["gpt-6-sol"],
      maxBudget: 20,
      budgetDuration: "1mo",
      duration: "30d",
    });
    expect(created.key).toMatch(/^sk-/);
    expect(created.alias).toBe("new-one");
    expect(await client.keyInfo(created.key)).toMatchObject({ maxBudget: 20, budgetDuration: "1mo" });

    await client.updateAlias(account, hashKey(created.key), "renamed");
    expect((await client.keyInfo(created.key)).alias).toBe("renamed");

    await client.deleteKeys(account, [hashKey(created.key)]);
    await expect(client.keyInfo(created.key)).rejects.toMatchObject({ status: 401 });
  });

  it("lists models the key may call", async () => {
    const secret = proxy.seed("models", "user-5", { models: ["gpt-6-sol", "claude-sonnet-5"] });
    expect(await client.listModels(secret)).toEqual(["claude-sonnet-5", "gpt-6-sol"]);
  });

  it("reads context windows, even with a key limited to model calls", async () => {
    proxy.modelWindows.set("claude-5-opus", 1_000_000);
    const secret = proxy.seed("windows", "user-5", { models: ["claude-5-opus", "claude-4.5-haiku"], allowed_routes: ["llm_api_routes"] });
    // The haiku group reports null, so it is left out.
    expect(await client.modelContextWindows(secret)).toEqual(new Map([["claude-5-opus", 1_000_000]]));
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

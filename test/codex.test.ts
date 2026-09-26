import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { applyCodexActivation, authCommand, findProfileOverride, restoreCodex } from "../src/targets/codex";

const activation = { providerId: "key-clarity", baseUrl: "https://llm.example.com", keyFilePath: "/home/u/.key-clarity/codex.key", alias: "proj-x" };

const existing = `# My Codex config
model = "gpt-5.5-codex"
model_provider = "openai"
approval_policy = "on-request"

[mcp_servers.docs]
command = "docs-mcp"   # keep this comment

[model_providers.azure]
name = "Azure"
base_url = "https://example.openai.azure.com/openai"
env_key = "AZURE_OPENAI_API_KEY"
`;

describe("applyCodexActivation", () => {
  it("adds the provider and selects it, keeping everything else", () => {
    const { text, previous } = applyCodexActivation(existing, activation);
    const cfg = parse(text) as any;
    expect(cfg.model_provider).toBe("key-clarity");
    expect(cfg.model).toBe("gpt-5.5-codex");
    expect(cfg.model_providers["key-clarity"]).toEqual({
      name: "LiteLLM (Key Clarity)",
      base_url: "https://llm.example.com/v1",
      wire_api: "responses",
      auth: { command: "cat", args: ["/home/u/.key-clarity/codex.key"], timeout_ms: 5000, refresh_interval_ms: 60000 },
    });
    expect(cfg.model_providers.azure.env_key).toBe("AZURE_OPENAI_API_KEY");
    expect(text).toContain(`command = "docs-mcp"   # keep this comment`);
    expect(text.startsWith("# My Codex config\n")).toBe(true);
    expect(previous).toEqual({ model_provider: { existed: true, value: "openai" } });
  });

  it("replaces its own tables on a second switch instead of duplicating them", () => {
    const first = applyCodexActivation(existing, activation).text;
    const second = applyCodexActivation(first, { ...activation, alias: "proj-y", keyFilePath: "/other.key" }).text;
    expect(second.match(/\[model_providers\.key-clarity\]/g)).toHaveLength(1);
    expect(second.match(/Managed by Key Clarity/g)).toHaveLength(1);
    expect((parse(second) as any).model_providers["key-clarity"].auth.args).toEqual(["/other.key"]);
  });

  it("works on an empty or missing file", () => {
    const { text, previous } = applyCodexActivation(undefined, activation);
    expect((parse(text) as any).model_provider).toBe("key-clarity");
    expect(previous).toEqual({ model_provider: { existed: false } });
  });

  it("inserts root keys above the first table when the file starts with one", () => {
    const { text } = applyCodexActivation(`[mcp_servers.x]\ncommand = "x"\n`, { ...activation, model: "gpt-6-sol" });
    expect(text.startsWith(`model_provider = "key-clarity"\nmodel = "gpt-6-sol"\n\n[mcp_servers.x]`)).toBe(true);
  });

  it("restores the original file after activation", () => {
    const { text, previous } = applyCodexActivation(existing, { ...activation, model: "gpt-6-sol" });
    expect(restoreCodex(text, previous, "key-clarity")).toBe(existing);
  });

  it("refuses when the provider is also defined with dotted keys", () => {
    const tricky = `model_providers.key-clarity.name = "hand-made"\n`;
    expect(() => applyCodexActivation(tricky, activation)).toThrow(/Couldn't update the Codex config safely/);
  });

  it("refuses invalid TOML", () => {
    expect(() => applyCodexActivation(`model = "unterminated\n`, activation)).toThrow(/isn't valid TOML/);
  });

  it("refuses Windows key paths cmd.exe would reinterpret", () => {
    expect(() => authCommand("C:\\Users\\R&D\\codex.key", "win32")).toThrow(/KEY_CLARITY_HOME/);
  });

  it("uses cmd /c type on Windows", () => {
    expect(authCommand("C:\\k\\codex.key", "win32")).toEqual({ command: "cmd", args: ["/d", "/c", "type", "C:\\k\\codex.key"] });
    const { text } = applyCodexActivation(undefined, { ...activation, keyFilePath: "C:\\k\\codex.key", platform: "win32" });
    expect((parse(text) as any).model_providers["key-clarity"].auth.args).toEqual(["/d", "/c", "type", "C:\\k\\codex.key"]);
  });
});

describe("findProfileOverride", () => {
  it("detects a selected profile that pins its own provider", () => {
    expect(findProfileOverride(`profile = "work"\n[profiles.work]\nmodel_provider = "azure"\n`)).toBe("work");
    expect(findProfileOverride(`profile = "work"\n[profiles.work]\nmodel = "x"\n`)).toBeUndefined();
  });
});

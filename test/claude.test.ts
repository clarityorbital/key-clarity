import { describe, expect, it } from "vitest";
import {
  applyClaudeActivation,
  findClaudeConflicts,
  helperCommand,
  isManagedHelper,
  mergePrevious,
  removeEnvVars,
  restoreClaude,
} from "../src/targets/claude";

const activation = { baseUrl: "https://llm.example.com", keyFilePath: "/home/u/.key-clarity/claude.key", alias: "proj-x", helperTtlMs: 60000 };

const existing = `{
    "$schema": "https://json.schemastore.org/claude-code-settings.json",
    // user comment survives
    "permissions": { "allow": ["Bash(ls:*)"] },
    "env": {
        "FOO": "bar"
    },
    "hooks": {}
}
`;

describe("helperCommand", () => {
  it("quotes the path and tags the alias", () => {
    expect(helperCommand("/a b/it's.key", "proj x!", "linux")).toBe(`cat '/a b/it'\\''s.key' # key-clarity:proj_x_`);
    expect(helperCommand("C:\\Users\\u\\.key-clarity\\claude.key", "k", "win32")).toBe(`cat 'C:/Users/u/.key-clarity/claude.key' # key-clarity:k`);
    expect(isManagedHelper(helperCommand("/k", "a"))).toBe(true);
    expect(isManagedHelper("my-own-script.sh")).toBe(false);
  });
});

describe("applyClaudeActivation", () => {
  it("creates settings from nothing", () => {
    const { text, previous } = applyClaudeActivation(undefined, activation);
    expect(JSON.parse(text)).toEqual({
      env: { ANTHROPIC_BASE_URL: "https://llm.example.com", CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "60000" },
      apiKeyHelper: "cat '/home/u/.key-clarity/claude.key' # key-clarity:proj-x",
    });
    expect(previous.env).toEqual({ existed: false });
  });

  it("keeps comments, formatting and unrelated settings", () => {
    const { text } = applyClaudeActivation(existing, activation);
    expect(text).toContain("// user comment survives");
    expect(text).toContain(`"permissions": { "allow": ["Bash(ls:*)"] }`);
    expect(text).toContain(`        "FOO": "bar",`);
    expect(text).toMatch(/^ {8}"ANTHROPIC_BASE_URL": "https:\/\/llm.example.com"/m);
  });

  it("records prior values and restores them exactly", () => {
    const mine = existing.replace(`"FOO": "bar"`, `"FOO": "bar",\n        "ANTHROPIC_BASE_URL": "https://old.example.com"`);
    const first = applyClaudeActivation(mine, activation);
    expect(first.previous["env.ANTHROPIC_BASE_URL"]).toEqual({ existed: true, value: "https://old.example.com" });
    expect(first.previous.apiKeyHelper).toEqual({ existed: false });

    // A second switch records nothing new for already-managed values but keeps the originals.
    const second = applyClaudeActivation(first.text, { ...activation, alias: "proj-y" });
    const merged = mergePrevious(JSON.parse(JSON.stringify(first.previous)), second.previous);
    expect(merged.apiKeyHelper).toEqual({ existed: false });

    const restored = restoreClaude(second.text, merged);
    expect(restored).toBe(mine);
  });

  it("removes an env block it created", () => {
    const { text, previous } = applyClaudeActivation(`{\n  "model": "opus"\n}\n`, activation);
    expect(JSON.parse(restoreClaude(text, previous))).toEqual({ model: "opus" });
  });

  it("refuses invalid JSON instead of overwriting it", () => {
    expect(() => applyClaudeActivation(`{ "env": `, activation)).toThrow(/isn't valid JSON/);
    expect(() => applyClaudeActivation(`{ "env": "oops" }`, activation)).toThrow(/isn't an object/);
  });

  it("skips the TTL variable when set to 0", () => {
    const { text } = applyClaudeActivation(undefined, { ...activation, helperTtlMs: 0 });
    expect(JSON.parse(text).env).toEqual({ ANTHROPIC_BASE_URL: "https://llm.example.com" });
  });
});

describe("conflicts", () => {
  it("finds credentials that outrank apiKeyHelper and removes them on request", () => {
    const text = `{ "env": { "ANTHROPIC_API_KEY": "sk-x", "ANTHROPIC_AUTH_TOKEN": "", "CLAUDE_CODE_USE_BEDROCK": "1", "FOO": "1" } }`;
    const conflicts = findClaudeConflicts(text);
    expect(conflicts).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"]);
    expect(JSON.parse(removeEnvVars(text, conflicts)).env).toEqual({ ANTHROPIC_AUTH_TOKEN: "", FOO: "1" });
  });
});

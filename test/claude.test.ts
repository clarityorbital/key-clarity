import { describe, expect, it } from "vitest";
import {
  applyClaudeActivation,
  DEFAULT_ENV_FLAGS,
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
    expect(helperCommand("C:\\Users\\u\\.key-clarity\\claude.key", "proj x!", "win32")).toBe(
      `type "C:\\Users\\u\\.key-clarity\\claude.key" & rem key-clarity:proj_x_`,
    );
    expect(isManagedHelper(helperCommand("/k", "a"))).toBe(true);
    expect(isManagedHelper(helperCommand("C:\\k", "a", "win32"))).toBe(true);
    expect(isManagedHelper("my-own-script.sh")).toBe(false);
  });

  it("refuses Windows paths cmd.exe would reinterpret", () => {
    expect(() => helperCommand("C:\\Users\\a%PATH%b\\.key-clarity\\claude.key", "k", "win32")).toThrow(/KEY_CLARITY_HOME/);
    expect(() => helperCommand("C:\\Users\\R&D\\claude.key", "k", "win32")).toThrow(/KEY_CLARITY_HOME/);
    expect(helperCommand("/home/R&D/claude.key", "k", "linux")).toBe(`cat '/home/R&D/claude.key' # key-clarity:k`);
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

describe("default env flags", () => {
  const allFlags = DEFAULT_ENV_FLAGS.map((f) => f.env);
  const withFlags = { ...activation, flags: allFlags };

  it("sets each switched-on flag to 1 and removes them all on undo", () => {
    const { text, previous } = applyClaudeActivation(existing, withFlags);
    expect(JSON.parse(text.replace(/^\s*\/\/.*$/m, "")).env).toEqual({
      FOO: "bar",
      ANTHROPIC_BASE_URL: "https://llm.example.com",
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "60000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    });
    expect(restoreClaude(text, previous)).toBe(existing);
  });

  it("puts a flag back when its switch is turned off", () => {
    const mine = existing.replace(`"FOO": "bar"`, `"FOO": "bar",\n        "DISABLE_TELEMETRY": "true"`);
    const first = applyClaudeActivation(mine, withFlags);
    expect(first.previous["env.DISABLE_TELEMETRY"]).toEqual({ existed: true, value: "true" });

    const fewer = allFlags.filter((f) => f !== "DISABLE_TELEMETRY" && f !== "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING");
    const second = applyClaudeActivation(first.text, { ...activation, flags: fewer }, first.previous);
    expect(second.released.sort()).toEqual(["env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING", "env.DISABLE_TELEMETRY"]);
    const env = JSON.parse(second.text.replace(/^\s*\/\/.*$/m, "")).env;
    expect(env.DISABLE_TELEMETRY).toBe("true");
    expect(env).not.toHaveProperty("CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");

    // Turning a switch back on records the user's value again, and a full undo still returns to it.
    const record = Object.fromEntries(Object.entries(first.previous).filter(([k]) => !second.released.includes(k)));
    const third = applyClaudeActivation(second.text, withFlags, record);
    expect(third.released).toEqual([]);
    const merged = mergePrevious(record, third.previous);
    expect(restoreClaude(third.text, merged)).toBe(mine);
  });

  it("leaves a flag the user already had alone", () => {
    const mine = existing.replace(`"FOO": "bar"`, `"FOO": "bar",\n        "DISABLE_TELEMETRY": "1"`);
    const first = applyClaudeActivation(mine, withFlags);
    expect(first.previous).not.toHaveProperty("env.DISABLE_TELEMETRY");
    const second = applyClaudeActivation(first.text, activation, first.previous);
    expect(second.released).not.toContain("env.DISABLE_TELEMETRY");
    expect(JSON.parse(second.text.replace(/^\s*\/\/.*$/m, "")).env.DISABLE_TELEMETRY).toBe("1");
  });

  it("releases the TTL variable when it's set to 0, but never a removed credential", () => {
    const first = applyClaudeActivation(undefined, activation);
    const earlier = { ...first.previous, "env.ANTHROPIC_API_KEY": { existed: true, inSecretStorage: true } };
    const second = applyClaudeActivation(first.text, { ...activation, helperTtlMs: 0 }, earlier);
    expect(second.released).toEqual(["env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS"]);
    expect(JSON.parse(second.text).env).toEqual({ ANTHROPIC_BASE_URL: "https://llm.example.com" });
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

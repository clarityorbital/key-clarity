import * as os from "node:os";
import * as path from "node:path";
import { applyEdits, modify, parse, ParseError, printParseErrorCode, type JSONPath } from "jsonc-parser";
import { MODEL_ENV_NAMES } from "./claudeModels";

// Edits Claude Code's settings.json in place with jsonc-parser, so the user's formatting,
// ordering and any other settings (hooks, MCP servers, permissions) are left untouched.

export const HELPER_MARKER = "key-clarity";
export const TTL_VAR = "CLAUDE_CODE_API_KEY_HELPER_TTL_MS";

/** Credentials that outrank apiKeyHelper in Claude Code's authentication order. */
export const OUTRANKING_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/**
 * Privacy and gateway-compatibility variables Key Clarity sets by default, each behind its own
 * `keyClarity.claude.<setting>` switch. When a switch is off, Key Clarity leaves the variable
 * alone. It never writes "0", because Claude Code treats any value of some of these as "on".
 */
export const DEFAULT_ENV_FLAGS = [
  { setting: "disableNonessentialTraffic", env: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" },
  { setting: "disableTelemetry", env: "DISABLE_TELEMETRY" },
  { setting: "disableExperimentalBetas", env: "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS" },
  { setting: "disableAdaptiveThinking", env: "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING" },
] as const;

/**
 * Variables Key Clarity writes only when a setting or the active key asks for them, and puts
 * back when it no longer does (a switch turned off, or a key without that model family).
 */
export const OPTIONAL_ENV: readonly string[] = [TTL_VAR, ...DEFAULT_ENV_FLAGS.map((f) => f.env), ...MODEL_ENV_NAMES];

export interface ClaudeActivation {
  baseUrl: string;
  keyFilePath: string;
  alias: string;
  /** Written as CLAUDE_CODE_API_KEY_HELPER_TTL_MS when > 0. */
  helperTtlMs: number;
  /** Variables from DEFAULT_ENV_FLAGS to set to "1". */
  flags?: readonly string[];
  /** Model alias variables (MODEL_ENV) and the model id each should hold. */
  models?: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
}

/**
 * What each managed path held before Key Clarity first wrote it, keyed by dotted path.
 * Stored as `{ existed, value }` because it is persisted as JSON, which drops `undefined`.
 */
export type PreviousValues = Record<string, { existed: boolean; value?: unknown; inSecretStorage?: boolean }>;

/** Pseudo-path recording whether the file had an `env` block before Key Clarity. */
const ENV_BLOCK = "env";

export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigEditError";
  }
}

export function claudeUserSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

export function claudeWorkspaceSettingsPath(workspacePath: string): string {
  return path.join(workspacePath, ".claude", "settings.local.json");
}

/**
 * The apiKeyHelper command. Claude Code runs it through the system shell: `/bin/sh` on
 * macOS and Linux, `cmd.exe` on Windows. The trailing comment names the key: it makes the
 * active key visible in the file, and changes the setting's value on every switch, which
 * makes Claude Code reload the helper right away.
 */
/** cmd.exe expands or interprets these even in arguments, so key-file paths must not contain them. */
const CMD_UNSAFE = /[%^&|<>!"]/;

export function assertCmdSafePath(p: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && CMD_UNSAFE.test(p)) {
    throw new ConfigEditError(
      `The key folder path "${p}" contains a character cmd.exe treats specially (% ^ & | < > ! "). Set the KEY_CLARITY_HOME environment variable to a plain folder such as C:\\key-clarity and restart VS Code.`,
    );
  }
}

export function helperCommand(keyFilePath: string, alias: string, platform: NodeJS.Platform = process.platform): string {
  const label = alias.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "key";
  if (platform === "win32") {
    assertCmdSafePath(keyFilePath, platform);
    // cmd.exe: no `cat`, and `#` isn't a comment. Windows paths can't contain `"`.
    return `type "${keyFilePath}" & rem ${HELPER_MARKER}:${label}`;
  }
  const quoted = `'${keyFilePath.replace(/'/g, `'\\''`)}'`;
  return `cat ${quoted} # ${HELPER_MARKER}:${label}`;
}

export function isManagedHelper(value: unknown): boolean {
  return typeof value === "string" && (value.includes(`# ${HELPER_MARKER}:`) || value.includes(`rem ${HELPER_MARKER}:`));
}

/** Paths Key Clarity owns in a Claude settings file. */
function managedPaths(a: ClaudeActivation): Array<[JSONPath, unknown]> {
  const entries: Array<[JSONPath, unknown]> = [
    [["env", "ANTHROPIC_BASE_URL"], a.baseUrl],
    [["apiKeyHelper"], helperCommand(a.keyFilePath, a.alias, a.platform)],
  ];
  if (a.helperTtlMs > 0) entries.push([["env", TTL_VAR], String(a.helperTtlMs)]);
  for (const name of a.flags ?? []) entries.push([["env", name], "1"]);
  for (const [name, id] of Object.entries(a.models ?? {})) entries.push([["env", name], id]);
  return entries;
}

export function parseSettings(text: string | undefined): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const e = errors[0];
    throw new ConfigEditError(`The settings file isn't valid JSON (${printParseErrorCode(e.error)} at offset ${e.offset}). Fix it and try again.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigEditError("The settings file must contain a JSON object.");
  }
  return value as Record<string, unknown>;
}

function getPath(obj: Record<string, unknown>, p: JSONPath): unknown {
  let cur: unknown = obj;
  for (const seg of p) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg as string];
  }
  return cur;
}

function setPath(text: string, p: JSONPath, value: unknown): string {
  const indent = detectIndent(text);
  const edits = modify(text, p, value, {
    formattingOptions: { insertSpaces: indent !== "\t", tabSize: indent === "\t" ? 1 : indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  });
  return applyEdits(text, edits);
}

function detectIndent(text: string): string {
  const m = /^([ \t]+)\S/m.exec(text);
  return m ? m[1] : "  ";
}

/**
 * Points Claude Code at the proxy and the key file. `previous` holds, for each path this
 * call changed, the value it had before, so the change can be undone later.
 *
 * `earlier` is what previous activations recorded. Optional variables it covers that this
 * activation no longer sets (a switch turned off, or the TTL set to 0) are put back to their
 * recorded value and listed in `released`, so the caller can drop them from its record.
 */
export function applyClaudeActivation(
  text: string | undefined,
  a: ClaudeActivation,
  earlier: PreviousValues = {},
): { text: string; previous: PreviousValues; released: string[] } {
  let out = text && text.trim() ? text : "{}\n";
  const current = parseSettings(out);
  if (current.env !== undefined && (typeof current.env !== "object" || current.env === null || Array.isArray(current.env))) {
    throw new ConfigEditError(`"env" in the settings file isn't an object.`);
  }
  const wanted = new Set(managedPaths(a).map(([p]) => p.join(".")));
  const released: string[] = [];
  for (const name of OPTIONAL_ENV) {
    const dotted = `env.${name}`;
    const prev = earlier[dotted];
    if (!prev || prev.inSecretStorage || wanted.has(dotted)) continue;
    out = setPath(out, ["env", name], prev.existed ? prev.value : undefined);
    released.push(dotted);
  }
  const previous: PreviousValues = {};
  if (current.env === undefined) previous[ENV_BLOCK] = { existed: false };
  for (const [p, value] of managedPaths(a)) {
    const before = getPath(current, p);
    if (before !== value) {
      previous[p.join(".")] = before === undefined ? { existed: false } : { existed: true, value: before };
      out = setPath(out, p, value);
    }
  }
  // Verify the result round-trips before anyone writes it.
  const after = parseSettings(out);
  for (const [p, value] of managedPaths(a)) {
    if (getPath(after, p) !== value) throw new ConfigEditError(`Could not set ${p.join(".")} in the settings file.`);
  }
  return { text: out, previous, released };
}

/** Restores the recorded values; paths recorded as absent are removed. */
export function restoreClaude(text: string | undefined, previous: PreviousValues): string {
  if (!text || !text.trim()) return text ?? "";
  let out = text;
  parseSettings(out);
  for (const [dotted, prev] of Object.entries(previous)) {
    if (dotted === ENV_BLOCK) continue;
    out = setPath(out, dotted.split("."), prev.existed ? prev.value : undefined);
  }
  // Drop an env block that Key Clarity created and that is now empty.
  const env = parseSettings(out).env;
  if (previous[ENV_BLOCK]?.existed === false && env && typeof env === "object" && Object.keys(env).length === 0) {
    out = setPath(out, ["env"], undefined);
  }
  return out;
}

/** Settings in the file that stop apiKeyHelper from being used. */
export function findClaudeConflicts(text: string | undefined): string[] {
  const settings = parseSettings(text);
  const env = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  return OUTRANKING_ENV.filter((name) => env[name] !== undefined && env[name] !== "" && env[name] !== "0");
}

/** Removes the named variables from the settings file's env block. */
export function removeEnvVars(text: string, names: string[]): string {
  let out = text;
  for (const name of names) out = setPath(out, ["env", name], undefined);
  return out;
}

/**
 * Merges a later activation's `previous` into the first one. The first recording of a path
 * wins, so undoing always returns to the state before Key Clarity touched it.
 */
export function mergePrevious(existing: PreviousValues | undefined, next: PreviousValues): PreviousValues {
  const merged: PreviousValues = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(next)) {
    if (!(k in merged)) merged[k] = v;
  }
  return merged;
}

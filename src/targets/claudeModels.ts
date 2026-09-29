// Picks the proxy models Claude Code's model aliases (opus, sonnet, haiku, fable) should use,
// from the models a key may call. Pure: no vscode, no network.

export type ClaudeFamily = "opus" | "sonnet" | "haiku" | "fable";

/** Env variables that point Claude Code's aliases at a model id, by family. */
export const MODEL_ENV: Record<ClaudeFamily, string> = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
};

export const MODEL_ENV_NAMES: readonly string[] = Object.values(MODEL_ENV);

/** Windows at or above this many input tokens count as 1M. */
const ONE_MILLION = 1_000_000;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

const ONE_M_SUFFIX = "[1m]";

export interface ParsedModel {
  family: ClaudeFamily;
  /** Major and minor version, such as [4, 6]; [0, 0] when the id has none. */
  version: [number, number];
}

/**
 * Reads the family and version from a proxy's model id, in the spellings proxies use:
 * `claude-sonnet-5`, `claude-5-sonnet`, `claude-4.5-haiku`, `claude-opus-4-7`,
 * `bedrock/anthropic.claude-sonnet-4-6-v1:0`, `claude-3-5-sonnet-20241022`.
 * Dates (4 or more digits) and `v1:0`-style suffixes are ignored.
 */
export function parseClaudeModel(id: string): ParsedModel | undefined {
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const family = tokens.find((t): t is ClaudeFamily => t in MODEL_ENV);
  if (!family) return undefined;
  const numbers: number[] = [];
  for (const t of tokens) {
    if (!/^\d{1,2}$/.test(t)) continue;
    numbers.push(Number(t));
    if (numbers.length === 2) break;
  }
  return { family, version: [numbers[0] ?? 0, numbers[1] ?? 0] };
}

/**
 * True for models that run with a 1M window without a beta header, per Claude Code's docs:
 * Sonnet 5 and later, Opus 4.7 and later, and every Fable model. Opus 4.6 and Sonnet 4.6
 * reach 1M only through a beta header, which proxies and CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
 * can strip, so they are left at 200K.
 */
export function hasNative1m(m: ParsedModel): boolean {
  const [major, minor] = m.version;
  switch (m.family) {
    case "fable":
      return true;
    case "sonnet":
      return major >= 5;
    case "opus":
      return major > 4 || (major === 4 && minor >= 7);
    case "haiku":
      return false;
  }
}

export interface PickedModel {
  id: string;
  /** Written with Claude Code's `[1m]` suffix. */
  oneM: boolean;
}

export type ModelPicks = Partial<Record<ClaudeFamily, PickedModel>>;

/**
 * Picks the newest model of each family from `ids`. `contextWindows` maps a model id to the
 * proxy's `max_input_tokens`; where the proxy reports one it decides the 1M window, and
 * where it doesn't, `hasNative1m` does.
 */
export function pickClaudeModels(ids: readonly string[], contextWindows: ReadonlyMap<string, number> = new Map()): ModelPicks {
  const best: Partial<Record<ClaudeFamily, { id: string; parsed: ParsedModel }>> = {};
  for (const id of ids) {
    // Ids come from the proxy and are written into settings: accept plain model-id characters only.
    if (!SAFE_ID.test(id)) continue;
    const parsed = parseClaudeModel(id);
    if (!parsed) continue;
    const current = best[parsed.family];
    if (!current || isBetter(id, parsed, current.id, current.parsed)) best[parsed.family] = { id, parsed };
  }
  const picks: ModelPicks = {};
  for (const [family, { id, parsed }] of Object.entries(best) as Array<[ClaudeFamily, { id: string; parsed: ParsedModel }]>) {
    const window = contextWindows.get(id);
    picks[family] = { id, oneM: window !== undefined ? window >= ONE_MILLION : hasNative1m(parsed) };
  }
  return picks;
}

/** Newer version wins; on a tie, the shorter id (usually the proxy's alias rather than a dated build). */
function isBetter(id: string, m: ParsedModel, otherId: string, other: ParsedModel): boolean {
  if (m.version[0] !== other.version[0]) return m.version[0] > other.version[0];
  if (m.version[1] !== other.version[1]) return m.version[1] > other.version[1];
  if (id.length !== otherId.length) return id.length < otherId.length;
  return id < otherId;
}

/** The env values to write: `id[1m]` where the 1M window applies and `use1m` allows it. */
export function modelEnv(picks: ModelPicks, use1m: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [family, pick] of Object.entries(picks) as Array<[ClaudeFamily, PickedModel]>) {
    env[MODEL_ENV[family]] = use1m && pick.oneM ? pick.id + ONE_M_SUFFIX : pick.id;
  }
  return env;
}

/** One line for a notification, such as "Models: opus → claude-5-opus (1M context), haiku → claude-4.5-haiku." */
export function describeModelEnv(env: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const [family, name] of Object.entries(MODEL_ENV) as Array<[ClaudeFamily, string]>) {
    const value = env[name];
    if (!value) continue;
    parts.push(value.endsWith(ONE_M_SUFFIX) ? `${family} → ${value.slice(0, -ONE_M_SUFFIX.length)} (1M context)` : `${family} → ${value}`);
  }
  return parts.length ? `Models: ${parts.join(", ")}.` : "";
}

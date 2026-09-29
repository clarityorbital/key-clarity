// Minimal client for the LiteLLM proxy's key-management and model endpoints.
// Kept free of `vscode` imports so it can be unit-tested against a mock server.

/** A spend limit, on a key, a user or a team. */
export interface Budget {
  /** Spend in the current budget period; LiteLLM resets it to 0 when the period ends. */
  spend: number;
  maxBudget: number | null;
  /** How often the budget resets, such as `1mo` or `30d`. Null for a total budget that never resets. */
  budgetDuration: string | null;
  budgetResetAt: string | null;
}

/**
 * One of a key's budget windows (LiteLLM's `budget_limits`, 1.93 and later): a limit per period, each
 * resetting on its own schedule. The proxy doesn't store spend per window; see `LiteLLMClient.keySpend`.
 */
export interface BudgetWindow {
  maxBudget: number;
  budgetDuration: string;
  resetAt: string | null;
  /** Spend in the current window, when known. */
  spend: number | null;
}

export interface KeyInfo extends Budget {
  /** Spend-limit windows besides `maxBudget`; empty when the key has none or the proxy predates them. */
  budgetWindows: BudgetWindow[];
  alias: string | null;
  expires: string | null;
  models: string[];
  userId: string | null;
  teamId: string | null;
  blocked: boolean;
  status: string | null;
}

export interface TeamBudget extends Budget {
  id: string;
  alias: string | null;
  /** The user's own budget within the team (LiteLLM's team member budget), often per month. */
  member: Budget | null;
}

/** Budgets that apply to every key of a user: the user's own, and those of the user's teams. */
export interface OwnerBudgets {
  userId: string | null;
  user: Budget | null;
  teams: TeamBudget[];
}

export interface RemoteKey extends KeyInfo {
  /** sha256 hex of the key, which LiteLLM stores as `token`. */
  hash: string;
  /** Masked form such as `sk-...AbCd`, when the proxy returns one. */
  maskedKey: string | null;
}

export interface GenerateKeyRequest {
  alias: string;
  models?: string[];
  maxBudget?: number;
  /** Reset period for `maxBudget`, such as `1mo`. */
  budgetDuration?: string;
  duration?: string;
}

export interface GeneratedKey {
  key: string;
  alias: string | null;
  expires: string | null;
}

/** True when the proxy refused the route for this key, as it does for keys limited to model calls. */
export function isForbidden(err: unknown): boolean {
  return err instanceof ProxyError && err.status === 403;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

type FetchFn = typeof fetch;

/** Strips trailing slashes and a trailing `/v1` so callers can paste either form. */
export function normalizeBaseUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol "${parsed.protocol}". Use http or https.`);
  }
  if (parsed.username || parsed.password) throw new Error("Remove the user name and password from the URL.");
  // Keep only origin and path: no query, fragment or credentials, no trailing slash or /v1.
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.toLowerCase().endsWith("/v1")) pathname = pathname.slice(0, -3).replace(/\/+$/, "");
  return parsed.origin + pathname;
}

/** True for plain-http URLs to anything but this machine, where keys would travel unencrypted. */
export function isInsecureRemote(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  const loopback = hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);
  return protocol === "http:" && !loopback;
}

/**
 * Makes proxy-supplied text safe to show in notifications, which render Markdown-style
 * `[text](command:…)` links: brackets become parentheses, whitespace collapses, length is capped.
 */
export function displaySafe(text: string, max = 200): string {
  const clean = text.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

export class LiteLLMClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /** Unauthenticated liveness probe. */
  async health(): Promise<void> {
    await this.request("GET", "/health/liveliness", undefined);
  }

  /**
   * Info for a key. With only `authKey`, looks up that key itself, which fails with 403 when
   * the proxy limits the key to model calls. With `keyHash`, looks up another key, which
   * needs a key with key-management access.
   */
  async keyInfo(authKey: string, keyHash?: string): Promise<KeyInfo> {
    const path = keyHash ? `/key/info?key=${encodeURIComponent(keyHash)}` : "/key/info";
    const body = await this.request("GET", path, authKey);
    return parseKeyInfo(asRecord(asRecord(body).info));
  }

  /**
   * A key's spend from `startDate` through `endDate` (UTC dates, `YYYY-MM-DD`), from the proxy's daily
   * spend table. `authKey` must belong to the same user as the key, and may be the key itself.
   * Uses `/user/daily/activity`, which internal users may call; the `/aggregated` variant is admin-only.
   * Each page's `metadata.total_spend` covers that page alone, so the pages are added up.
   */
  async keySpend(authKey: string, keyHash: string, startDate: string, endDate: string): Promise<number> {
    let total = 0;
    for (let page = 1; page <= 20; page++) {
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate, api_key: keyHash, page_size: "1000", page: String(page) });
      const metadata = asRecord(asRecord(await this.request("GET", `/user/daily/activity?${params}`, authKey)).metadata);
      if (typeof metadata.total_spend !== "number") throw new ProxyError("The proxy did not return a spend total.", null);
      total += metadata.total_spend;
      if (metadata.has_more !== true) break;
    }
    return total;
  }

  /**
   * The budgets of the key's user and that user's teams, including the user's member budget in each
   * team. Needs a key allowed to call `/user/info` and `/team/info`.
   */
  async ownerBudgets(authKey: string): Promise<OwnerBudgets> {
    const body = asRecord(await this.request("GET", "/user/info", authKey));
    const userId = typeof body.user_id === "string" ? body.user_id : null;
    const user = body.user_info && typeof body.user_info === "object" ? parseBudget(asRecord(body.user_info)) : null;
    const teams: TeamBudget[] = [];
    for (const item of Array.isArray(body.teams) ? body.teams : []) {
      const row = asRecord(item);
      if (typeof row.team_id !== "string") continue;
      const member = userId ? await this.memberBudget(authKey, row.team_id, userId).catch(() => null) : null;
      teams.push({ ...parseBudget(row), id: row.team_id, alias: typeof row.team_alias === "string" ? row.team_alias : null, member });
    }
    return { userId, user, teams };
  }

  /** The user's member budget in a team: the limit and period from the membership's budget, and the member's spend. */
  private async memberBudget(authKey: string, teamId: string, userId: string): Promise<Budget | null> {
    const body = asRecord(await this.request("GET", `/team/info?team_id=${encodeURIComponent(teamId)}`, authKey));
    const memberships = Array.isArray(body.team_memberships) ? body.team_memberships : [];
    const membership = memberships.map(asRecord).find((m) => m.user_id === userId);
    if (!membership || !membership.litellm_budget_table) return null;
    const limits = parseBudget(asRecord(membership.litellm_budget_table));
    return { ...limits, spend: num(membership.spend) ?? 0 };
  }

  async listKeys(authKey: string, userId: string | null): Promise<RemoteKey[]> {
    const keys: RemoteKey[] = [];
    for (let page = 1; page <= 20; page++) {
      const params = new URLSearchParams({ return_full_object: "true", size: "100", page: String(page) });
      if (userId) params.set("user_id", userId);
      const body = asRecord(await this.request("GET", `/key/list?${params}`, authKey));
      const items = Array.isArray(body.keys) ? body.keys : [];
      for (const item of items) {
        const row = asRecord(item);
        const hash = typeof row.token === "string" ? row.token : null;
        if (!hash) continue;
        keys.push({
          ...parseKeyInfo(row),
          hash,
          maskedKey: typeof row.key_name === "string" ? row.key_name : null,
        });
      }
      const totalPages = typeof body.total_pages === "number" ? body.total_pages : 1;
      if (page >= totalPages || items.length === 0) break;
    }
    return keys;
  }

  async generateKey(authKey: string, req: GenerateKeyRequest): Promise<GeneratedKey> {
    const payload: Record<string, unknown> = { key_alias: req.alias };
    if (req.models && req.models.length > 0) payload.models = req.models;
    if (req.maxBudget !== undefined) payload.max_budget = req.maxBudget;
    if (req.budgetDuration) payload.budget_duration = req.budgetDuration;
    if (req.duration) payload.duration = req.duration;
    const body = asRecord(await this.request("POST", "/key/generate", authKey, payload));
    if (typeof body.key !== "string" || body.key.length === 0) {
      throw new ProxyError("The proxy did not return a key.", null);
    }
    return {
      key: body.key,
      alias: typeof body.key_alias === "string" ? body.key_alias : null,
      expires: typeof body.expires === "string" ? body.expires : null,
    };
  }

  /** Accepts raw keys or their sha256 hashes. */
  async deleteKeys(authKey: string, keysOrHashes: string[]): Promise<void> {
    await this.request("POST", "/key/delete", authKey, { keys: keysOrHashes });
  }

  async updateAlias(authKey: string, keyOrHash: string, alias: string): Promise<void> {
    await this.request("POST", "/key/update", authKey, { key: keyOrHash, key_alias: alias });
  }

  /** Model ids the key may call, from the OpenAI-compatible `/v1/models`. */
  async listModels(key: string): Promise<string[]> {
    const body = asRecord(await this.request("GET", "/v1/models", key));
    const data = Array.isArray(body.data) ? body.data : [];
    return data
      .map((m) => asRecord(m).id)
      .filter((id): id is string => typeof id === "string")
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Input-token limit per model name, from LiteLLM's `/model_group/info` (allowed for keys
   * limited to model calls). Models the proxy doesn't report a limit for are left out.
   */
  async modelContextWindows(key: string): Promise<Map<string, number>> {
    const body = asRecord(await this.request("GET", "/model_group/info", key));
    const data = Array.isArray(body.data) ? body.data : [];
    const windows = new Map<string, number>();
    for (const entry of data) {
      const row = asRecord(entry);
      if (typeof row.model_group === "string" && typeof row.max_input_tokens === "number" && row.max_input_tokens > 0) {
        windows.set(row.model_group, row.max_input_tokens);
      }
    }
    return windows;
  }

  private async request(method: string, path: string, bearer: string | undefined, json?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (json !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        // Never follow redirects: they could carry the Authorization header somewhere else.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ProxyError(`Could not reach ${this.baseUrl}: ${reason}`, null);
    }

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // Non-JSON bodies (such as the liveness text) are returned as-is.
    }
    if (!res.ok) {
      throw new ProxyError(`${method} ${path.split("?")[0]} failed (${res.status}): ${displaySafe(errorMessage(body))}`, res.status);
    }
    return body;
  }
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function parseBudget(row: Record<string, unknown>): Budget {
  return {
    spend: num(row.spend) ?? 0,
    maxBudget: num(row.max_budget),
    budgetDuration: str(row.budget_duration),
    budgetResetAt: str(row.budget_reset_at),
  };
}

function parseKeyInfo(row: Record<string, unknown>): KeyInfo {
  // A key linked to a budget tier takes the tier's limit and period wherever it has none of its own,
  // the same way the proxy enforces them.
  const tier = asRecord(row.litellm_budget_table);
  const own = parseBudget(row);
  return {
    spend: own.spend,
    maxBudget: own.maxBudget ?? num(tier.max_budget),
    budgetDuration: own.budgetDuration ?? str(tier.budget_duration),
    budgetResetAt: own.budgetDuration ? own.budgetResetAt : (str(tier.budget_reset_at) ?? own.budgetResetAt),
    budgetWindows: parseWindows(row.budget_limits),
    alias: typeof row.key_alias === "string" ? row.key_alias : null,
    expires: typeof row.expires === "string" ? row.expires : null,
    models: Array.isArray(row.models) ? row.models.filter((m): m is string => typeof m === "string") : [],
    userId: str(row.user_id),
    teamId: str(row.team_id),
    blocked: row.blocked === true,
    status: typeof row.status === "string" ? row.status : null,
  };
}

/** `budget_limits` arrives as a list, or as the JSON text of one. */
function parseWindows(value: unknown): BudgetWindow[] {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: BudgetWindow[] = [];
  for (const item of list) {
    const w = asRecord(item);
    const maxBudget = num(w.max_budget);
    const budgetDuration = str(w.budget_duration);
    if (maxBudget === null || !budgetDuration) continue;
    out.push({ maxBudget, budgetDuration, resetAt: str(w.reset_at), spend: null });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300) || "no details";
  const rec = asRecord(body);
  const error = rec.error;
  if (typeof error === "string") return error;
  const nested = asRecord(error).message;
  if (typeof nested === "string") return nested;
  const detail = rec.detail;
  if (typeof detail === "string") return detail;
  const detailError = asRecord(detail).error;
  if (typeof detailError === "string") return detailError;
  return JSON.stringify(body).slice(0, 300);
}

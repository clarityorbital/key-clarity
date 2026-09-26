// Minimal client for the LiteLLM proxy's key-management and model endpoints.
// Kept free of `vscode` imports so it can be unit-tested against a mock server.

export interface KeyInfo {
  alias: string | null;
  spend: number;
  maxBudget: number | null;
  budgetResetAt: string | null;
  expires: string | null;
  models: string[];
  userId: string | null;
  blocked: boolean;
  status: string | null;
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
  duration?: string;
}

export interface GeneratedKey {
  key: string;
  alias: string | null;
  expires: string | null;
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
  let url = raw.trim().replace(/\/+$/, "");
  if (url.toLowerCase().endsWith("/v1")) {
    url = url.slice(0, -3).replace(/\/+$/, "");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol "${parsed.protocol}". Use http or https.`);
  }
  return url;
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

  /** Info for the key used as the bearer token. Works for any valid key, admin or not. */
  async keyInfo(key: string): Promise<KeyInfo> {
    const body = await this.request("GET", "/key/info", key);
    return parseKeyInfo(asRecord(asRecord(body).info));
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
      throw new ProxyError(`${method} ${path.split("?")[0]} failed (${res.status}): ${errorMessage(body)}`, res.status);
    }
    return body;
  }
}

function parseKeyInfo(row: Record<string, unknown>): KeyInfo {
  return {
    alias: typeof row.key_alias === "string" ? row.key_alias : null,
    spend: typeof row.spend === "number" ? row.spend : 0,
    maxBudget: typeof row.max_budget === "number" ? row.max_budget : null,
    budgetResetAt: typeof row.budget_reset_at === "string" ? row.budget_reset_at : null,
    expires: typeof row.expires === "string" ? row.expires : null,
    models: Array.isArray(row.models) ? row.models.filter((m): m is string => typeof m === "string") : [],
    userId: typeof row.user_id === "string" ? row.user_id : null,
    blocked: row.blocked === true,
    status: typeof row.status === "string" ? row.status : null,
  };
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

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A small in-memory stand-in for the LiteLLM proxy's key endpoints, shaped after
// litellm/proxy/management_endpoints/key_management_endpoints.py.

interface Row {
  token: string;
  key_alias: string | null;
  key_name: string;
  spend: number;
  max_budget: number | null;
  budget_duration?: string | null;
  budget_reset_at?: string | null;
  /** A linked budget tier, which `/key/info` includes. */
  litellm_budget_table?: { max_budget?: number | null; budget_duration?: string | null; budget_reset_at?: string | null } | null;
  expires: string | null;
  models: string[];
  user_id: string;
  /** `["llm_api_routes"]` limits the key to model calls, as many proxies configure. */
  allowed_routes: string[];
}

export interface MockProxy {
  url: string;
  rows: Map<string, Row>;
  models: string[];
  /** Adds a key owned by `userId` and returns its secret. */
  seed(alias: string, userId?: string, extra?: Partial<Row>): string;
  /** Every request, with the credential from `Authorization: Bearer` or `x-api-key`. */
  requests: Array<{ method: string; path: string; auth: string | undefined }>;
  close(): Promise<void>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function startMockProxy(): Promise<MockProxy> {
  const rows = new Map<string, Row>();
  const requests: MockProxy["requests"] = [];
  const models = ["claude-sonnet-5", "gpt-5.6-terra", "gpt-6-sol"];

  const seed = (alias: string, userId = "user-1", extra: Partial<Row> = {}) => {
    const secret = `sk-${randomBytes(12).toString("base64url")}`;
    rows.set(sha(secret), {
      token: sha(secret),
      key_alias: alias,
      key_name: `sk-...${secret.slice(-4)}`,
      spend: 0,
      max_budget: null,
      expires: null,
      models: [],
      user_id: userId,
      allowed_routes: [],
      ...extra,
    });
    return secret;
  };

  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const apiKeyHeader = req.headers["x-api-key"];
    const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? (typeof apiKeyHeader === "string" ? apiKeyHeader : undefined);
    requests.push({ method: req.method ?? "", path: url.pathname, auth });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/health/liveliness") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify("I'm alive!"));
      return;
    }
    const caller = auth ? rows.get(sha(auth)) : undefined;
    if (!caller) return send(401, { error: { message: "Authentication Error, Invalid proxy server token passed.", code: "401" } });

    if (caller.allowed_routes.includes("llm_api_routes") && url.pathname.startsWith("/key/")) {
      return send(403, {
        error: { message: "Virtual key is not allowed to call this route. Only allowed to call routes: ['llm_api_routes']", code: "403" },
      });
    }
    if (req.method === "GET" && url.pathname === "/key/info") {
      const wanted = url.searchParams.get("key");
      const row = wanted ? rows.get(wanted.startsWith("sk-") ? sha(wanted) : wanted) : caller;
      if (!row || row.user_id !== caller.user_id) return send(404, { detail: { error: "Key not found" } });
      const { token, ...info } = row;
      return send(200, { key: wanted ?? auth, info: { ...info, status: "active" } });
    }
    if (req.method === "GET" && url.pathname === "/key/list") {
      const userId = url.searchParams.get("user_id");
      if (userId !== caller.user_id) return send(403, { detail: { error: "Only admins can list other users' keys." } });
      const keys = [...rows.values()].filter((r) => r.user_id === userId);
      return send(200, { keys, total_count: keys.length, current_page: 1, total_pages: 1 });
    }
    if (req.method === "POST" && url.pathname === "/key/generate") {
      const body = await readBody(req);
      const secret = seed(body.key_alias ?? null, caller.user_id, {
        models: body.models ?? [],
        max_budget: body.max_budget ?? null,
        budget_duration: body.budget_duration ?? null,
        expires: body.duration ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null,
      });
      return send(200, { key: secret, key_alias: body.key_alias ?? null, expires: rows.get(sha(secret))?.expires });
    }
    if (req.method === "POST" && url.pathname === "/key/delete") {
      const body = await readBody(req);
      const deleted: string[] = [];
      for (const k of body.keys ?? []) {
        const h = k.startsWith("sk-") ? sha(k) : k;
        if (rows.delete(h)) deleted.push(k);
      }
      return send(200, { deleted_keys: deleted });
    }
    if (req.method === "POST" && url.pathname === "/key/update") {
      const body = await readBody(req);
      const h = body.key.startsWith("sk-") ? sha(body.key) : body.key;
      const row = rows.get(h);
      if (!row) return send(404, { detail: { error: "Key not found" } });
      row.key_alias = body.key_alias;
      return send(200, { key: body.key, key_alias: body.key_alias });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const allowed = caller.models.length ? caller.models : models;
      return send(200, { object: "list", data: allowed.map((id) => ({ id, object: "model" })) });
    }
    send(404, { detail: "Not Found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    rows,
    models,
    seed,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

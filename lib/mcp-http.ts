import { randomUUID } from "node:crypto";
import { log, type ErrorCategory, type Usage } from "./log";
import { callTool, INSTRUCTIONS, SERVER, TOOLS, type ToolContext } from "./mcp";

// Stateless MCP over Streamable HTTP. Every POST carries one JSON-RPC message and is answered with
// one JSON body. There are no sessions and no server-to-client stream.
export const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MAX_BODY_BYTES = 64 * 1024;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, authorization, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};

type Id = string | number | null;
export type McpResponse = { status: number; body: unknown | null };
type Rpc = { status: number; body: unknown | null; method: string; tool?: string; category?: ErrorCategory; usage?: Usage };

const result = (id: Id, value: unknown, method: string, extra: Partial<Rpc> = {}): Rpc => ({ status: 200, body: { jsonrpc: "2.0", id, result: value }, method, ...extra });
const failure = (id: Id, code: number, message: string, status: number, method: string, category: ErrorCategory, extra: Partial<Rpc> = {}): Rpc => ({
  status,
  body: { jsonrpc: "2.0", id, error: { code, message } },
  method,
  category,
  ...extra,
});

// DNS rebinding defense (MCP spec, transport security). A rebinding attack reaches this server
// with a Host header naming the attacker's domain, so only answer for hostnames we serve.
// Vercel sets VERCEL_URL, VERCEL_BRANCH_URL and VERCEL_PROJECT_PRODUCTION_URL on every deployment.
// Origin is not restricted: the server is public and CORS allows any site.
export function allowedHosts(env: Record<string, string | undefined> = process.env) {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", "one-link-eta.vercel.app"]);
  for (const v of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL, ...(env.MCP_ALLOWED_HOSTS ?? "").split(",")])
    if (v?.trim()) hosts.add(v.trim().toLowerCase());
  return hosts;
}

export function hostAllowed(host: string | null, hosts = allowedHosts()) {
  if (!host) return false;
  const h = host.toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d+$/, "");
  return hosts.has(name) || hosts.has(h);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function dispatch(raw: string, headers: Headers, ctx: ToolContext): Promise<Rpc> {
  if (!hostAllowed(headers.get("host"))) return failure(null, -32600, "Unknown host.", 403, "-", "forbidden_host");
  // Spec: a request with an unsupported MCP-Protocol-Version header gets 400 Bad Request.
  const version = headers.get("mcp-protocol-version");
  if (version && !VERSIONS.includes(version))
    return failure(null, -32600, `Unsupported MCP-Protocol-Version: ${version}. Supported: ${VERSIONS.join(", ")}.`, 400, "-", "unsupported_version");

  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return failure(null, -32700, "Parse error: the body is not valid JSON.", 400, "-", "parse_error");
  }

  // Batches were removed from MCP in 2025-06-18 and no current client sends them.
  if (Array.isArray(msg)) return failure(null, -32600, "Send one JSON-RPC message per POST. Batches aren't supported.", 400, "-", "invalid_request");
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return failure(null, -32600, "Not a JSON-RPC 2.0 message.", 400, "-", "invalid_request");

  // A JSON-RPC response from the client (we never send requests, but accept them per spec).
  if (msg.method === undefined && msg.id !== undefined && ("result" in msg || "error" in msg)) return { status: 202, body: null, method: "response" };
  if (typeof msg.method !== "string") return failure(null, -32600, "A JSON-RPC request needs a string method.", 400, "-", "invalid_request");
  const method = msg.method;

  // Notifications (no id) are accepted with no body.
  if (msg.id === undefined) return { status: 202, body: null, method };
  if (typeof msg.id !== "string" && typeof msg.id !== "number")
    return failure(null, -32600, "The request id must be a string or a number.", 400, method, "invalid_request");
  const id = msg.id;
  if (msg.params !== undefined && !isObject(msg.params)) return failure(id, -32602, "params must be an object.", 200, method, "invalid_arguments");
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return result(
        id,
        {
          protocolVersion: typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        },
        method,
      );
    }
    case "ping":
      return result(id, {}, method);
    case "tools/list":
      return result(id, { tools: TOOLS }, method);
    // Some clients ask for these even when the server doesn't offer them.
    case "resources/list":
      return result(id, { resources: [] }, method);
    case "resources/templates/list":
      return result(id, { resourceTemplates: [] }, method);
    case "prompts/list":
      return result(id, { prompts: [] }, method);
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return failure(id, -32602, "tools/call needs a tool name.", 200, method, "invalid_arguments");
      if (params.arguments !== undefined && !isObject(params.arguments))
        return failure(id, -32602, "tools/call arguments must be an object.", 200, method, "invalid_arguments", { tool: name });
      let outcome;
      try {
        outcome = await callTool(name, (params.arguments ?? {}) as Record<string, unknown>, ctx);
      } catch {
        // Never pass internal error text to the caller.
        return result(id, { content: [{ type: "text", text: "Something went wrong on our side. Try again in a minute." }], isError: true }, method, {
          tool: name,
          category: "internal",
        });
      }
      if (!outcome) return failure(id, -32602, `Unknown tool: ${name}`, 200, method, "unknown_tool", { tool: name });
      return result(id, outcome.result, method, { tool: name, category: outcome.category, usage: outcome.usage });
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`, 200, method, "method_not_found");
  }
}

export async function handleMcp(raw: string, headers: Headers, ctx: ToolContext): Promise<McpResponse> {
  const started = performance.now();
  const requestId = headers.get("x-vercel-id") ?? randomUUID();
  const rpc =
    Buffer.byteLength(raw) > MAX_BODY_BYTES
      ? failure(null, -32600, `Request body over ${MAX_BODY_BYTES} bytes.`, 413, "-", "payload_too_large")
      : await dispatch(raw, headers, ctx);
  const isError = Boolean(rpc.category);
  log({
    event: "mcp_request",
    request_id: requestId,
    method: rpc.method,
    ...(rpc.tool && { tool: rpc.tool }),
    ok: !isError,
    status: rpc.status,
    ...(rpc.category && { error_category: rpc.category }),
    duration_ms: Math.round(performance.now() - started),
    ...(rpc.usage && { usage: rpc.usage }),
  });
  return { status: rpc.status, body: rpc.body };
}

// Progress notifications. A client that wants them sends `_meta.progressToken` on tools/call and
// accepts text/event-stream (MCP spec, Streamable HTTP). For the two slow tools only, the answer is
// then an SSE stream: notifications/progress as the tool moves through real phases, a heartbeat
// every 5 s with the elapsed time, then the JSON-RPC response. Everything else stays plain JSON, so
// clients that don't ask for progress see no change. Not every client sends a progress token.
const SLOW_TOOLS = new Set(["brief_for_job", "brief_from_job_post"]);
export const HEARTBEAT_MS = 5000;

export function progressToken(raw: string, headers: Headers): string | number | null {
  if (!(headers.get("accept") ?? "").includes("text/event-stream")) return null;
  // Requests the protocol gates would reject keep their normal HTTP status.
  if (!hostAllowed(headers.get("host")) || Buffer.byteLength(raw) > MAX_BODY_BYTES) return null;
  const version = headers.get("mcp-protocol-version");
  if (version && !VERSIONS.includes(version)) return null;
  try {
    const m = JSON.parse(raw);
    if (!isObject(m) || m.jsonrpc !== "2.0" || m.method !== "tools/call" || (typeof m.id !== "string" && typeof m.id !== "number")) return null;
    const params = m.params as { name?: unknown; _meta?: { progressToken?: unknown } } | undefined;
    if (typeof params?.name !== "string" || !SLOW_TOOLS.has(params.name)) return null;
    const token = params._meta?.progressToken;
    return typeof token === "string" || typeof token === "number" ? token : null;
  } catch {
    return null;
  }
}

export function streamMcp(raw: string, headers: Headers, ctx: ToolContext, token: string | number, heartbeatMs = HEARTBEAT_MS): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const started = Date.now();
      let progress = 0;
      let phase = "Working on it";
      const send = (msg: unknown) => controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
      const notify = () =>
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: ++progress, message: `${phase} (${Math.round((Date.now() - started) / 1000)} s)` },
        });
      const heartbeat = setInterval(notify, heartbeatMs);
      handleMcp(raw, headers, { ...ctx, progress: (p) => ((phase = p), notify()) })
        .then(({ body }) => send(body))
        .catch(() => send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }))
        .finally(() => {
          clearInterval(heartbeat);
          controller.close();
        });
    },
  });
}

// Reads at most `max` bytes so an oversized body can't be buffered whole.
export async function readCapped(body: ReadableStream<Uint8Array> | null, max = MAX_BODY_BYTES): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

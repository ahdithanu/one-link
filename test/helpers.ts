import { handleMcp } from "@/lib/mcp-http";
import type { ToolContext } from "@/lib/mcp";

process.env.ONE_LINK_LOG ??= "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;

export const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  origin: "https://example.test",
  limited: () => false,
  eventLimited: () => true,
  ...over,
});

let n = 0;
export async function rpc(method: string, params?: unknown, opts: { headers?: Record<string, string>; ctx?: ToolContext } = {}) {
  const id = ++n;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });
  const res = await handleMcp(body, new Headers({ host: "localhost:3210", ...opts.headers }), opts.ctx ?? ctx());
  return { id, ...res, json: res.body as { jsonrpc: string; id: number; result?: any; error?: { code: number; message: string } } };
}

export const raw = (body: string, headers: Record<string, string> = {}) => handleMcp(body, new Headers({ host: "localhost:3210", ...headers }), ctx());

export async function call(name: string, args?: unknown, c?: ToolContext) {
  const res = await rpc("tools/call", { name, ...(args !== undefined && { arguments: args }) }, { ctx: c });
  return res.json.result as { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };
}

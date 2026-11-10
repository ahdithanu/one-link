import { NextRequest, NextResponse } from "next/server";
import { clientIp, limited } from "@/lib/limit";
import { callTool, INSTRUCTIONS, SERVER, TOOLS } from "@/lib/mcp";

export const runtime = "nodejs";
export const maxDuration = 60;

// Stateless MCP over Streamable HTTP: every POST is one JSON-RPC message answered with plain JSON.
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, authorization",
};

type Id = string | number | null;
const reply = (id: Id, result: unknown) => NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: CORS });
const error = (id: Id, code: number, message: string, status = 200) =>
  NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: CORS });

export async function POST(req: NextRequest) {
  const msg = await req.json().catch(() => undefined);
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return error(null, -32600, "Send one JSON-RPC 2.0 request per POST.", 400);

  // Notifications and client responses need no answer.
  if (msg.id === undefined) return new NextResponse(null, { status: 202, headers: CORS });
  const id: Id = msg.id;
  const params = msg.params ?? {};

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    // Some clients ask for these even when the server doesn't offer them.
    case "resources/list":
      return reply(id, { resources: [] });
    case "prompts/list":
      return reply(id, { prompts: [] });
    case "tools/call": {
      if (typeof params.name !== "string") return error(id, -32602, "tools/call needs a tool name.");
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const result = await callTool(params.name, args, {
        origin: req.nextUrl.origin,
        limited: () => limited(clientIp(req.headers)),
      }).catch(() => ({ content: [{ type: "text" as const, text: "Something went wrong on our side. Try again in a minute." }], isError: true }));
      return result ? reply(id, result) : error(id, -32602, `Unknown tool: ${params.name}`);
    }
    default:
      return error(id, -32601, `Method not found: ${msg.method}`);
  }
}

// No server-to-client stream and no sessions.
export function GET() {
  return new NextResponse(null, { status: 405, headers: { ...CORS, allow: "POST" } });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

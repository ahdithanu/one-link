// One JSON line per event, read from Vercel's runtime logs. Never pass job post text, tool
// arguments, API keys or IP addresses in here.

export type ErrorCategory =
  | "parse_error"
  | "invalid_request"
  | "unsupported_version"
  | "forbidden_host"
  | "payload_too_large"
  | "method_not_found"
  | "unknown_tool"
  | "invalid_arguments"
  | "not_found"
  | "rate_limited"
  | "fetch_failed"
  | "not_a_job_post"
  | "model_unavailable"
  | "model_rate_limited"
  | "model_error"
  | "internal";

export type Usage = { model: string; input_tokens: number; output_tokens: number };

export type LogLine = {
  event: "mcp_request";
  request_id: string;
  method: string;
  tool?: string;
  ok: boolean;
  status: number;
  error_category?: ErrorCategory;
  duration_ms: number;
  usage?: Usage;
};

export function log(line: LogLine) {
  if (process.env.ONE_LINK_LOG === "off") return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));
}

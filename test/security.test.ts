import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkUrl, fetchJobPost, FetchBlocked, isPrivate, pageToPost, safeLookup } from "@/lib/fetch-post";
import { clientIp, createLimiter } from "@/lib/limit";
import { allowedHosts, handleMcp, hostAllowed, readCapped } from "@/lib/mcp-http";
import { ctx } from "./helpers";

describe("SSRF: address classification", () => {
  const blockedIps = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "fec0::1", "not-an-ip",
  ];
  for (const ip of blockedIps) it(`blocks ${ip}`, () => assert.equal(isPrivate(ip), true));
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
    it(`allows public ${ip}`, () => assert.equal(isPrivate(ip), false));
});

describe("SSRF: url rules", () => {
  for (const [label, url] of [
    ["plain http", "http://example.com/job"],
    ["a non-443 port", "https://example.com:8443/job"],
    ["credentials in the url", "https://user:pass@example.com/job"],
    ["a private IPv4 literal", "https://169.254.169.254/latest/meta-data"],
    ["a loopback IPv6 literal", "https://[::1]/job"],
  ]) it(`rejects ${label}`, () => assert.throws(() => checkUrl(new URL(url)), FetchBlocked));
  it("allows a public https url", () => assert.doesNotThrow(() => checkUrl(new URL("https://example.com/jobs/1"))));

  it("the socket lookup refuses a hostname that resolves to loopback", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup("localhost", {}, (e) => resolve(e)));
    assert.ok(err instanceof FetchBlocked);
  });
  it("fetchJobPost refuses https://localhost", async () => {
    await assert.rejects(fetchJobPost("https://localhost/job"), FetchBlocked);
  });
  it("fetchJobPost refuses the cloud metadata address", async () => {
    await assert.rejects(fetchJobPost("https://169.254.169.254/"), FetchBlocked);
  });
});

describe("page parsing", () => {
  it("prefers JobPosting JSON-LD", () => {
    const ld = JSON.stringify({ "@type": "JobPosting", title: "Engineer", hiringOrganization: { name: "Acme" }, description: `<p>${"Build things. ".repeat(40)}</p>` });
    const text = pageToPost(`<html><script type="application/ld+json">${ld}</script><body>nav</body></html>`)!;
    assert.match(text, /^Engineer\nAcme\nBuild things/);
  });
  it("rejects pages with too little text", () => assert.equal(pageToPost("<p>Hi</p>"), null));
  it("drops scripts and styles", () => {
    const text = pageToPost(`<script>steal()</script><style>x{}</style><p>${"Real job text. ".repeat(40)}</p>`)!;
    assert.doesNotMatch(text, /steal|x\{\}/);
  });
});

describe("rate limits", () => {
  it("allows max calls then blocks within the window", () => {
    const limited = createLimiter(3, 1000);
    assert.deepEqual([0, 1, 2, 3].map(() => limited("a", 0)), [false, false, false, true]);
    assert.equal(limited("b", 0), false, "other callers are unaffected");
  });
  it("frees capacity after the window passes", () => {
    const limited = createLimiter(1, 1000);
    assert.equal(limited("a", 0), false);
    assert.equal(limited("a", 999), true);
    assert.equal(limited("a", 1000), false);
  });
  it("keeps memory bounded under many distinct keys", () => {
    const limited = createLimiter(1, 1000);
    for (let i = 0; i < 20_000; i++) limited(`k${i}`, 0);
    assert.equal(limited("k19999", 0), true, "recent keys are kept");
    assert.equal(limited("k0", 0), false, "oldest keys were evicted");
  });
  it("reads the client ip from x-real-ip, then x-forwarded-for", () => {
    assert.equal(clientIp(new Headers({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" })), "1.1.1.1");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" })), "2.2.2.2");
    assert.equal(clientIp(new Headers()), "unknown");
  });
});

describe("request size", () => {
  it("readCapped stops reading past the cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const text = await readCapped(stream, 64 * 1024);
    assert.ok(text.length <= 80 * 1024);
    assert.ok(pulled < 10);
  });
});

describe("logging", () => {
  it("logs tool, outcome and timing but never the job post or arguments", async () => {
    const lines: string[] = [];
    const orig = console.log;
    const prev = process.env.ONE_LINK_LOG;
    process.env.ONE_LINK_LOG = "on";
    console.log = (s: string) => lines.push(s);
    try {
      const secret = "CONFIDENTIAL-ROLE-" + "x".repeat(300);
      await handleMcp(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brief_from_job_post", arguments: { job_post: secret } } }),
        new Headers({ host: "localhost", "x-real-ip": "9.9.9.9" }),
        ctx(),
      );
    } finally {
      console.log = orig;
      process.env.ONE_LINK_LOG = prev;
    }
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.tool, "brief_from_job_post");
    assert.equal(line.ok, false);
    assert.equal(line.error_category, "model_unavailable");
    assert.equal(typeof line.duration_ms, "number");
    assert.equal(typeof line.request_id, "string");
    assert.doesNotMatch(lines[0], /CONFIDENTIAL|9\.9\.9\.9/);
  });
});

describe("DNS rebinding: Host allowlist", () => {
  const hosts = allowedHosts({ VERCEL_URL: "one-link-abc123.vercel.app", MCP_ALLOWED_HOSTS: "onelink.example, other.example" });
  for (const h of ["localhost", "localhost:3210", "127.0.0.1:3000", "[::1]:3210", "one-link-eta.vercel.app", "ONE-LINK-ETA.vercel.app", "one-link-abc123.vercel.app", "onelink.example", "other.example"])
    it(`accepts ${h}`, () => assert.equal(hostAllowed(h, hosts), true));
  for (const h of ["evil.example.com", "localhost.evil.com", "one-link-eta.vercel.app.evil.com", "", "10.0.0.5"])
    it(`rejects ${JSON.stringify(h)}`, () => assert.equal(hostAllowed(h, hosts), false));
  it("rejects a missing Host header", () => assert.equal(hostAllowed(null, hosts), false));
  it("handleMcp answers 403 for a rebinding Host", async () => {
    const r = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), new Headers({ host: "evil.example.com", origin: "http://evil.example.com" }), ctx());
    assert.equal(r.status, 403);
  });
});

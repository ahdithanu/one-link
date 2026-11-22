import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const MAX_HOPS = 4;

// Everything that is not a public unicast address.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, bits, "ipv6");

// IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:7f00:1) is judged by the IPv4 address inside it.
// A BlockList also matches IPv4 addresses against this range, so it lives in its own list.
const mappedRange = new BlockList();
mappedRange.addSubnet("::ffff:0:0", 96, "ipv6");

function mappedToV4(ip: string) {
  const tail = ip.toLowerCase().replace(/^\[|\]$/g, "").split(":");
  const last = tail[tail.length - 1];
  if (isIP(last) === 4) return last;
  const hi = parseInt(tail[tail.length - 2] ?? "0", 16);
  const lo = parseInt(last, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isPrivate(ip: string) {
  const family = isIP(ip);
  if (family === 0) return true;
  if (family === 4) return blocked.check(ip, "ipv4");
  if (mappedRange.check(ip, "ipv6")) return blocked.check(mappedToV4(ip), "ipv4");
  return blocked.check(ip, "ipv6");
}

export class FetchBlocked extends Error {}

export function checkUrl(url: URL) {
  if (url.protocol !== "https:") throw new FetchBlocked("https only");
  if (url.port && url.port !== "443") throw new FetchBlocked("blocked port");
  if (url.username || url.password) throw new FetchBlocked("credentials in url");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivate(url.hostname.replace(/^\[|\]$/g, ""))) throw new FetchBlocked("blocked host");
}

// The address check runs inside the socket's own DNS lookup, so the address that is checked is the
// address that is connected to. A second resolution (DNS rebinding) can't swap in a private IP.
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export function safeLookup(hostname: string, options: object, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isPrivate(a.address))) {
      return callback(Object.assign(new FetchBlocked("blocked host"), { code: "EBLOCKED" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

type Page = { status: number; location: string | null; contentType: string; body: string };

function get(url: URL): Promise<Page> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        lookup: safeLookup as never,
        timeout: TIMEOUT_MS,
        headers: { "user-agent": "one-link", accept: "text/html", "accept-encoding": "gzip, deflate, br" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location ?? null;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, contentType, body: "" });
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream: Readable = res;
        if (encoding === "gzip") stream = res.pipe(createGunzip());
        else if (encoding === "deflate") stream = res.pipe(createInflate());
        else if (encoding === "br") stream = res.pipe(createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        // Stop reading at the cap instead of buffering an unbounded body.
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= MAX_BYTES) {
            req.destroy();
            resolve({ status, location, contentType, body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8") });
          }
        });
        stream.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function toText(html: string) {
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => entities[m] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function fromJsonLd(html: string) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item?.["@type"] === "JobPosting" && item.description) {
          return `${item.title ?? ""}\n${item.hiringOrganization?.name ?? ""}\n${toText(String(item.description))}`;
        }
      }
    } catch {}
  }
  return null;
}

export function pageToPost(html: string) {
  const text = fromJsonLd(html) ?? toText(html);
  return text.length >= 400 ? text.slice(0, 20000) : null;
}

export async function fetchJobPost(raw: string): Promise<string | null> {
  let url = new URL(raw);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    checkUrl(url);
    const page = await get(url);
    if (page.status >= 300 && page.status < 400) {
      if (!page.location) return null;
      url = new URL(page.location, url);
      continue;
    }
    if (page.status < 200 || page.status >= 300 || !page.contentType.includes("html")) return null;
    return pageToPost(page.body);
  }
  return null;
}

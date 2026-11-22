// Runs against a real Redis behind the Upstash REST API (locally: Redis plus the serverless-redis-http
// emulator; see README). Each worker is a separate Node process, so nothing is shared but Redis.
// Skipped unless UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN point at a test database AND
// ONE_LINK_TEST_REDIS=1 is set. It resets the global brief counter, so never point it at production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { getRedis } from "@/lib/limit";

const run = promisify(execFile);
const configured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && process.env.ONE_LINK_TEST_REDIS === "1");
const opts = { skip: configured ? false : "no test Redis configured" };

async function instances(n: number, mode: string, arg: (i: number) => string) {
  const startAt = Date.now() + 4000; // lets every process boot before they all fire together
  const outs = await Promise.all(
    Array.from({ length: n }, (_, i) => run("npx", ["tsx", "test-integration/worker.mts", mode, String(startAt), arg(i)], { env: process.env, timeout: 60_000 })),
  );
  return outs.map((o) => JSON.parse(o.stdout.trim().split("\n").pop()!));
}

describe("distributed limits and locks across processes", opts, () => {
  it("8 instances, one caller: exactly 5 briefs allowed in the hour", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID()}`;
    const res = await instances(8, "limit", () => ip);
    assert.equal(res.filter((r) => !r.limited).length, 5);
  });

  it("4 instances, 80 different callers: exactly 60 briefs allowed across everyone", async () => {
    await getRedis()!.del("one-link:rl:brief-all:all");
    const tag = randomUUID();
    const res = await instances(4, "limit-many", (i) => `${tag}-${i}:20`);
    assert.equal(res.reduce((n, r) => n + r.allowed, 0), 60);
    await getRedis()!.del("one-link:rl:brief-all:all");
  });

  it("10 instances racing for a daily budget of 3: exactly 3 reservations", async () => {
    const day = `test-${randomUUID()}`;
    const res = await instances(10, "reserve", () => `${day}:3`);
    assert.equal(res.filter((r) => r.reserved).length, 3);
  });

  it("6 instances asking for the same new brief: one model call, everyone gets the brief", async () => {
    const id = randomUUID();
    const res = await instances(6, "write", () => id);
    const generations = Number(await getRedis()!.get(`test:generations:${id}`));
    assert.equal(generations, 1);
    assert.equal(res.filter((r) => r.error).length, 0, JSON.stringify(res));
    assert.equal(res.filter((r) => r.cached === false).length, 1);
  });
});

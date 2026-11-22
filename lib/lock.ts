import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";

// A distributed lock on Redis: SET NX PX acquires atomically with a bounded expiry, and release
// deletes the key only if it still holds this owner's token. A worker whose lock already expired
// can't release a lock another worker has since taken.

export type LockStore = Pick<Redis, "set" | "eval" | "exists">;

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function acquireLock(store: LockStore, key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const ok = await store.set(key, token, { nx: true, px: ttlMs });
  return ok === "OK" ? token : null;
}

export async function releaseLock(store: LockStore, key: string, token: string): Promise<boolean> {
  const n = await store.eval(RELEASE, [key], [token]);
  return Number(n) === 1;
}

export async function lockHeld(store: LockStore, key: string) {
  return (await store.exists(key)) === 1;
}

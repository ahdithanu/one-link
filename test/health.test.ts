import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthReport } from "@/lib/health";

describe("health report", () => {
  it("says plainly when limits are per instance, and never includes secret values", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value-for-test";
    try {
      const h = await healthReport();
      assert.equal(h.limits.scope, "per-instance");
      assert.equal(h.limits.redis.configured, false);
      assert.ok(h.degraded.some((d) => /per instance/.test(d)));
      assert.equal(h.model.configured, true);
      assert.doesNotMatch(JSON.stringify(h), /sk-ant|secret-value/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression for the shipped-default half of the auto-buy finding: config.json must NOT
// ship with autonomous buying enabled.
test("shipped config.json has autoLp.enabled = false", () => {
  const p = fileURLToPath(new URL("../config.json", import.meta.url));
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(cfg.autoLp.enabled, false, "autoLp must be OFF in the shipped config");
});

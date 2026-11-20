import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candidate, Verdict } from "../src/radar/radar.js";

// Regression for the core finding: no buy may go out before a conclusive security audit
// passes, even on the "feed-new" fast source that the chain listener drives with
// attacker-controlled tokens.
// Hermetic: dead local RPC + no wallet key, so nothing can reach a live chain even if the gate regresses.
process.env.RH_RPC_URL = "http://127.0.0.1:9";
delete process.env.RH_WALLET_KEY;
const RID = Math.random().toString(16).slice(2, 10);
const verdict: Verdict = { llm: { score: 98, action: "ape", summary: "x" }, gmgn: null } as unknown as Verdict;
const mkCandidate = (tag: string): Candidate =>
  ({ token: "0x" + tag.padEnd(40, "0"), symbol: "T" + tag.slice(0, 4), source: "feed-new", onchainBackPct: 100 } as unknown as Candidate);

const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string) => unknown): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
    return new Response(JSON.stringify(handler(url) ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("maybeAutoLp skips (no buy) when the audit is inconclusive", { timeout: 5000 }, async () => {
  const { cfg } = await import("../src/config.js");
  const { maybeAutoLp } = await import("../src/radar/autolp.js");
  cfg.autoLp.enabled = true; // force the path on even though shipped default is now off
  stubFetch(() => ({})); // GoPlus returns no data -> audited=false
  try {
    const r = await maybeAutoLp(mkCandidate("a" + RID), verdict);
    assert.ok(r, "expected a result");
    assert.equal(r!.opened, false);
    assert.match(r!.reason, /audit inconclusive/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("maybeAutoLp skips (no buy) when the token is a honeypot", { timeout: 5000 }, async () => {
  const { cfg } = await import("../src/config.js");
  const { maybeAutoLp } = await import("../src/radar/autolp.js");
  cfg.autoLp.enabled = true;
  stubFetch((url) =>
    url.includes("gopluslabs")
      ? { result: { [mkCandidate("b" + RID).token.toLowerCase()]: { is_honeypot: "1" } } }
      : {},
  );
  try {
    const r = await maybeAutoLp(mkCandidate("b" + RID), verdict);
    assert.ok(r, "expected a result");
    assert.equal(r!.opened, false);
    assert.match(r!.reason, /security scan failed/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

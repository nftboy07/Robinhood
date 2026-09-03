/**
 * Candidate pipeline: for sniper sources, auto-LP FIRST; score/notify async.
 */
import { cfg } from "../config.js";
import { scoreCandidate, type Candidate, type Verdict } from "../radar/radar.js";
import { maybeAutoLp } from "../radar/autolp.js";
import { notifySpike, notifyNewToken, notifyAutoLp } from "./notify.js";
import { logger } from "../util/log.js";
import type { SpikeHit } from "../types.js";
import type { NewTokenAlert } from "../feed/monitor.js";

const log = logger("pipeline");

async function runAuto(candidate: Candidate, verdict: Verdict | null): Promise<void> {
  try {
    const r = await maybeAutoLp(candidate, verdict);
    if (r?.opened) void notifyAutoLp(r).catch(() => {});
  } catch (e) {
    log.error(`auto-lp err: ${(e as Error).message}`);
  }
}

/** Watch/scan spike → auto-LP first when attach off; else score parallel with notify. */
export async function handleSpike(h: SpikeHit): Promise<void> {
  const candidate: Candidate = {
    token: h.addr,
    symbol: h.symbol,
    source: "watch-spike",
    vol5m: h.vol5m,
    vol1h: h.vol1h,
    liq: h.liq,
    fdv: h.fdv,
    onchainBackPct: h.safe.backPct,
    onchainTaxPct: h.safe.taxPct,
  };

  if (!cfg.radar.attachToWatch) {
    void notifySpike(h, null).catch(() => {});
    await runAuto(candidate, null);
    return;
  }

  const verdictP = scoreCandidate(candidate).catch(() => null);
  // Don't block buy on notify
  void verdictP.then((v) => notifySpike(h, v).catch(() => {}));
  const verdict = await verdictP;
  await runAuto(candidate, verdict);
}

/** Feed new-token → SNIPE FIRST, score/notify in background. */
export async function handleNewToken(a: NewTokenAlert): Promise<void> {
  const candidate: Candidate = {
    token: a.token,
    symbol: a.symbol,
    source: "feed-new",
    fee: a.fee,
    wethSeed: a.wethSeed,
    onchainBackPct: a.backPct,
  };

  // Critical path: buy immediately with synthetic high-confidence verdict
  const fastVerdict: Verdict = {
    llm: { score: 95, action: "ape", summary: "feed-new fast path" },
    gmgn: null,
  };
  const buyP = runAuto(candidate, fastVerdict);

  void notifyNewToken(a, fastVerdict).catch(() => {});
  if (cfg.radar.attachToNewToken) {
    void scoreCandidate(candidate).catch(() => null); // enrichment only
  }

  await buyP;
}

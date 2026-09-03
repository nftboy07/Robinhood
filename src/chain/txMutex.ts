/**
 * Atomic Nonce Mutex & Transaction Sequencer
 * Assigns consecutive nonces. Callers should broadcast inside the lock and
 * wait for receipts OUTSIDE so emergency exits are not blocked behind confirmations.
 */
import { provider, wallet } from "./client.js";
import { logger } from "../util/log.js";

const log = logger("tx-mutex");

let mutexQueue: Promise<void> = Promise.resolve();
let trackedNonce: number | null = null;

/**
 * @param spend How many nonces `fn` will consume (default 1).
 *              Increment happens after fn resolves successfully — do not await
 *              inclusion inside fn unless spend accounts for every send.
 */
export async function withTxLock<T>(fn: (nonce: number) => Promise<T>, spend = 1): Promise<T> {
  let release: () => void;
  const currentTask = new Promise<void>((resolve) => {
    release = resolve;
  });

  const previousTask = mutexQueue;
  mutexQueue = previousTask.then(() => currentTask);

  await previousTask;
  try {
    const w = wallet();
    if (trackedNonce === null) {
      trackedNonce = await provider.getTransactionCount(w.address, "pending");
    }
    const activeNonce = trackedNonce;
    const result = await fn(activeNonce);
    trackedNonce = activeNonce + Math.max(1, spend);
    return result;
  } catch (err: any) {
    const msg = String(err?.message || err?.info?.error?.message || err);
    log.warn(`[TX MUTEX] Resetting nonce tracker (${msg.slice(0, 80)})`);
    trackedNonce = null;
    throw err;
  } finally {
    release!();
  }
}

/** Force re-sync from chain (e.g. after external txs). */
export function resetNonceTracker(): void {
  trackedNonce = null;
}

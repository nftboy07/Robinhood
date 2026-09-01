/**
 * Atomic Nonce Mutex & Transaction Sequencer
 * Prevents "nonce too low" or "nonce has already been used" race conditions across concurrent tasks.
 */
import { provider, wallet } from "./client.js";
import { logger } from "../util/log.js";

const log = logger("tx-mutex");

let mutexQueue: Promise<void> = Promise.resolve();
let trackedNonce: number | null = null;

export async function withTxLock<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
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
    trackedNonce = activeNonce + 1;
    return result;
  } catch (err: any) {
    const msg = String(err?.message || err?.info?.error?.message || "");
    if (msg.includes("nonce") || msg.includes("NONCE_EXPIRED")) {
      log.warn(`[TX MUTEX] Nonce conflict detected (${msg.slice(0, 60)}), resetting nonce tracker...`);
      trackedNonce = null;
    }
    throw err;
  } finally {
    release!();
  }
}

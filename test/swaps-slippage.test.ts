import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";

// Regression: the multi-fire WETH->token buy must carry a real slippage-bounded
// amountOutMinimum (never 0), and must refuse to send when no quote is available.
// Runs against a LOCAL mock JSON-RPC only; throwaway key; no network.
const QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
const ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
// constant-product pool: 10 WETH : 1e6 tokens (18 decimals)
const R_W = 10n * 10n ** 18n;
const R_T = 1_000_000n * 10n ** 18n;
const cpOut = (x: bigint): bigint => (R_T * x) / (R_W + x);

let quoterLive = true;
let nonce = 0;
const raws: string[] = [];
let server: http.Server;
let quoterAddr = "";

function result(method: string, params: any[]): unknown {
  switch (method) {
    case "eth_chainId": return "0x1237";
    case "net_version": return "4663";
    case "eth_blockNumber": return "0x3e8";
    case "eth_gasPrice": case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
    case "eth_getBalance": return "0xde0b6b3a7640000";
    case "eth_getTransactionCount": return "0x" + nonce.toString(16);
    case "eth_estimateGas": return "0x55730";
    case "eth_call": {
      const { to, data } = params[0];
      if (quoterLive && String(to).toLowerCase() === quoterAddr && data.startsWith(QUOTER_IFACE.getFunction("quoteExactInputSingle")!.selector)) {
        const [p] = QUOTER_IFACE.decodeFunctionData("quoteExactInputSingle", data);
        return QUOTER_IFACE.encodeFunctionResult("quoteExactInputSingle", [cpOut(BigInt(p.amountIn)), 0n, 0n, 0n]);
      }
      return "0x" + "0".repeat(64);
    }
    case "eth_getBlockByNumber": return {
      number: "0x3e8", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32),
      timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16), gasLimit: "0x1c9c380", gasUsed: "0x0",
      baseFeePerGas: null, miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0",
      nonce: "0x0000000000000000", extraData: "0x", transactions: [],
    };
    case "eth_sendRawTransaction": { raws.push(params[0]); nonce++; return ethers.keccak256(params[0]); }
    default: return null;
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = JSON.parse(body);
      const arr = Array.isArray(reqs) ? reqs : [reqs];
      const out = arr.map((r: any) => ({ jsonrpc: "2.0", id: r.id, result: result(r.method, r.params ?? []) }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(reqs) ? out : out[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.RH_RPC_URL = "http://127.0.0.1:" + (server.address() as any).port;
  process.env.RH_WALLET_KEY = ethers.Wallet.createRandom().privateKey;
  delete process.env.RH_FAST_SUBMIT;
  const { C } = await import("../src/config.js");
  quoterAddr = C.quoter.toLowerCase();
});

after(() => server.close());

const swapsSent = () =>
  raws
    .map((r) => ethers.Transaction.from(r))
    .filter((t) => t.data.startsWith(ROUTER_IFACE.getFunction("exactInputSingle")!.selector))
    .map((t) => ROUTER_IFACE.decodeFunctionData("exactInputSingle", t.data)[0]);

test("each tranche has a slippage-bounded, non-zero amountOutMinimum", async () => {
  const { swapWethToTokenMultiFire } = await import("../src/chain/swaps.js");
  const { cfg } = await import("../src/config.js");
  raws.length = 0;
  const amounts = [ethers.parseEther("0.003"), ethers.parseEther("0.002"), ethers.parseEther("0.005")];
  const token = "0x" + "c0ffee".padEnd(40, "1");
  await swapWethToTokenMultiFire(token, amounts, 3000);

  const sent = swapsSent();
  assert.equal(sent.length, 3);
  const bps = BigInt(Math.round(cfg.lp.slippagePct * 100));
  let cum = 0n;
  let prev = 0n;
  for (const [i, s] of sent.entries()) {
    cum += amounts[i]!;
    const q = cpOut(cum);
    const expected = ((q - prev) * (10_000n - bps)) / 10_000n;
    prev = q;
    assert.ok(BigInt(s.amountOutMinimum) > 0n, "amountOutMinimum must not be 0");
    assert.equal(BigInt(s.amountOutMinimum), expected);
  }
});

test("refuses to send any swap when no quote is available", async () => {
  const { swapWethToTokenMultiFire } = await import("../src/chain/swaps.js");
  raws.length = 0;
  quoterLive = false;
  try {
    await assert.rejects(
      swapWethToTokenMultiFire("0x" + "dead".padEnd(40, "2"), [ethers.parseEther("0.003")], 3000),
      /refusing zero-slippage buy/,
    );
    assert.equal(swapsSent().length, 0, "no swap may be broadcast without a quote");
  } finally {
    quoterLive = true;
  }
});

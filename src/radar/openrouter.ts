/**
 * LLM screener client — any OpenAI-compatible chat-completions endpoint (OpenRouter by
 * default; RH_OPENROUTER_URL points it at a custom gateway). stream:false so we always get
 * one JSON body. Best-effort: returns null if no key or on any failure.
 */
import { env } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("llm");

export interface LlmVerdict {
  score: number; // 0..100 conviction
  action: "ape" | "watch" | "skip";
  summary: string;
}

export async function llmScore(system: string, user: string): Promise<LlmVerdict | null> {
  if (!env.openrouterKey) return null;

  // Pool of free models to rotate through in case of rate limits or model failures
  const models = [
    env.openrouterModel,
    "nvidia/nemotron-4-340b-instruct:free",
    "meta-llama/llama-3-8b-instruct:free",
    "google/gemma-2-9b-it:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "microsoft/phi-3-medium-128k-instruct:free"
  ].filter((v, i, a) => v && a.indexOf(v) === i); // deduplicate

  for (const model of models) {
    const body = JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      stream: false, // some gateways stream by default; we want one JSON body
      temperature: 0.2,
      max_tokens: 1200,
    });

    log.info(`Trying LLM screening with model: ${model}`);

    try {
      const res = await fetch(env.openrouterUrl, {
        method: "POST",
        headers: { 
          Authorization: `Bearer ${env.openrouterKey}`, 
          "Content-Type": "application/json", 
          "X-Title": "Robinhood LP Bot" 
        },
        body,
        signal: AbortSignal.timeout(40_000),
      });

      if (res.status === 429) {
        log.warn(`model ${model} rate limited (429) — trying next fallback model`);
        continue;
      }
      if (!res.ok) {
        log.warn(`model ${model} returned HTTP ${res.status} — trying next fallback model`);
        continue;
      }

      const j: any = await res.json();
      const msg = j?.choices?.[0]?.message ?? {};
      const verdict = parseVerdict(msg.content || msg.reasoning || "");
      if (verdict) {
        log.info(`LLM screening succeeded with model: ${model}`);
        return verdict;
      }
    } catch (e) {
      log.warn(`model ${model} call failed: ${(e as Error).message} — trying next fallback model`);
    }
  }
  return null;
}

function parseVerdict(content: string): LlmVerdict | null {
  let obj: any;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/); // some models wrap JSON in prose
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const score = Math.max(0, Math.min(100, Number(obj.score) || 0));
  const action = ["ape", "watch", "skip"].includes(obj.action) ? obj.action : score >= 70 ? "ape" : score >= 40 ? "watch" : "skip";
  return { score, action, summary: String(obj.summary ?? "").slice(0, 240) };
}

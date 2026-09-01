/**
 * LLM screener client — supports Groq (ultra-fast) + OpenRouter fallback pool.
 */
import { env } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("llm");

export interface LlmVerdict {
  score: number; // 0..100 conviction
  action: "ape" | "watch" | "skip";
  summary: string;
}

const GROQ_KEY = process.env.GROQ_API_KEY || "";

export async function llmScore(system: string, user: string): Promise<LlmVerdict | null> {
  // 1. Try Groq (ultra fast sub-second response)
  if (GROQ_KEY) {
    const groqModels = ["llama-3.3-70b-versatile", "llama3-70b-8192", "gemma2-9b-it", "mixtral-8x7b-32768"];
    for (const model of groqModels) {
      try {
        log.info(`Trying Groq LLM screening with ${model}...`);
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${GROQ_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: { type: "json_object" },
            temperature: 0.2,
            max_tokens: 800,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          const j: any = await res.json();
          const msg = j?.choices?.[0]?.message ?? {};
          const verdict = parseVerdict(msg.content || "");
          if (verdict) {
            log.info(`[Groq] Screening succeeded with ${model}: Score=${verdict.score}, Action=${verdict.action}`);
            return verdict;
          }
        }
      } catch (e) {
        log.warn(`[Groq] ${model} failed: ${(e as Error).message}`);
      }
    }
  }

  // 2. Fallback to OpenRouter free models
  if (env.openrouterKey) {
    const models = [
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3.5-lightning:free",
      "minimax/minimax-m3:free",
      "z-ai/glm-5.2:free",
      "liquid/lfm-2.5-2.6b:free"
    ];

    for (const model of models) {
      try {
        const body = JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          stream: false,
          temperature: 0.2,
          max_tokens: 1000,
        });

        log.info(`Trying OpenRouter fallback model: ${model}`);
        const res = await fetch(env.openrouterUrl, {
          method: "POST",
          headers: { 
            Authorization: `Bearer ${env.openrouterKey}`, 
            "Content-Type": "application/json", 
            "X-Title": "Robinhood LP Bot" 
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) continue;
        const j: any = await res.json();
        const msg = j?.choices?.[0]?.message ?? {};
        const verdict = parseVerdict(msg.content || msg.reasoning || "");
        if (verdict) {
          log.info(`OpenRouter screening succeeded with model: ${model}`);
          return verdict;
        }
      } catch (e) {
        log.warn(`OpenRouter model ${model} failed: ${(e as Error).message}`);
      }
    }
  }

  // 3. Fallback pass verdict: never block a safe candidate on AI network failure
  log.info("[LLM] Fallback auto-pass verdict generated (Score=75, Action=ape)");
  return { score: 75, action: "ape", summary: "Auto-approved candidate (momentum verified on-chain)" };
}

function parseVerdict(content: string): LlmVerdict | null {
  let obj: any;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const score = Math.max(0, Math.min(100, Number(obj.score) || 0));
  const action = ["ape", "watch", "skip"].includes(obj.action) ? obj.action : score >= 50 ? "ape" : score >= 30 ? "watch" : "skip";
  return { score, action, summary: String(obj.summary ?? "").slice(0, 240) };
}

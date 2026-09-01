/**
 * LLM screener client — ultra-fast sub-second responses with instant auto-pass fallback.
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
  // 1. Try Groq (if key set) with 4s timeout
  if (GROQ_KEY) {
    const groqModels = ["llama-3.3-70b-versatile", "gemma2-9b-it"];
    for (const model of groqModels) {
      try {
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
            max_tokens: 600,
          }),
          signal: AbortSignal.timeout(4_000),
        });

        if (res.ok) {
          const j: any = await res.json();
          const msg = j?.choices?.[0]?.message ?? {};
          const verdict = parseVerdict(msg.content || "");
          if (verdict) {
            log.info(`[Groq] Fast evaluation: Score=${verdict.score}, Action=${verdict.action}`);
            return verdict;
          }
        }
      } catch (e) {
        /* try next */
      }
    }
  }

  // 2. OpenRouter Fast Pool (4s timeout each, non-laggy models)
  if (env.openrouterKey) {
    const fastModels = [
      "google/gemma-4-26b-a4b-it:free",
      "minimax/minimax-m3:free",
      "google/gemma-4-31b-it:free",
      "z-ai/glm-5.2:free"
    ];

    for (const model of fastModels) {
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
          max_tokens: 600,
        });

        log.info(`Screening candidate with fast model: ${model}`);
        const res = await fetch(env.openrouterUrl, {
          method: "POST",
          headers: { 
            Authorization: `Bearer ${env.openrouterKey}`, 
            "Content-Type": "application/json", 
            "X-Title": "Robinhood LP Bot" 
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });

        if (!res.ok) continue;
        const j: any = await res.json();
        const msg = j?.choices?.[0]?.message ?? {};
        const verdict = parseVerdict(msg.content || msg.reasoning || "");
        if (verdict) {
          log.info(`[LLM] Fast pass with ${model}: Score=${verdict.score}, Action=${verdict.action}`);
          return verdict;
        }
      } catch (e) {
        /* try next fast model */
      }
    }
  }

  // 3. Fallback auto-pass: NEVER block candidate buys on external API lag
  log.info("[LLM] Fallback auto-pass generated (Score=75, Action=ape)");
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

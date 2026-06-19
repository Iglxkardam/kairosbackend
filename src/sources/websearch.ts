import { env } from "../env.js";
import { log } from "../log.js";
import { recordUsage } from "../llm.js";

// web search is NOT optional — it grounds the research in what's ACTUALLY trending right now.
// that grounding is exactly what keeps the ideas accurate and the hallucination low.
// primary: gemini's built-in google-search grounding (no extra key). fallback: tavily (open-source path).

type GeminiPart = { text?: string };
type GeminiResp = {
  candidates?: { content?: { parts?: GeminiPart[] }; groundingMetadata?: { groundingChunks?: { web?: { title?: string } }[] } }[];
  usageMetadata?: unknown;
};

async function geminiGrounded(query: string): Promise<string[]> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.LLM_PRIMARY_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${query}\nlist the concrete trending crypto topics and narratives right now, one per line, no preamble.` }] }],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`gemini grounding ${r.status}`);
  const j = (await r.json()) as GeminiResp;
  recordUsage(j.usageMetadata, "gemini", env.LLM_PRIMARY_MODEL); // grounding counts toward the run total
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
  const sources = (cand?.groundingMetadata?.groundingChunks ?? []).map((c) => c.web?.title).filter((x): x is string => !!x);
  const lines = text.split("\n").map((s) => s.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean);
  return [...new Set([...lines, ...sources])].slice(0, 12);
}

async function tavily(query: string): Promise<string[]> {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: env.SEARCH_API_KEY, query, max_results: 6, search_depth: "basic" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const j = (await r.json()) as { results?: { title?: string; content?: string }[] };
  return (j.results ?? []).map((x) => `${x.title ?? ""} — ${(x.content ?? "").slice(0, 160)}`.trim());
}

export async function trendSearch(query: string): Promise<string[]> {
  if (env.GEMINI_API_KEY) {
    try {
      const hits = await geminiGrounded(query);
      log.debug({ hits: hits.length }, "trend search (gemini grounding)");
      if (hits.length) return hits;
    } catch (e) {
      log.warn({ err: String(e) }, "gemini grounding failed, falling back to tavily");
    }
  }
  if (env.SEARCH_API_KEY) {
    try {
      const hits = await tavily(query);
      log.debug({ hits: hits.length }, "trend search (tavily)");
      return hits;
    } catch (e) {
      log.warn({ err: String(e) }, "tavily failed");
    }
  }
  log.warn("no grounded search reachable — research falls back to model knowledge (lower freshness)");
  return [];
}

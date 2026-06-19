import type { Logger } from "pino";
import { askJSON, llmReady, sys, user, z } from "./llm.js";
import { fromReddit } from "./sources/reddit.js";
import { fromNews } from "./sources/news.js";
import { fromYoutube } from "./sources/youtube.js";
import { trendSearch } from "./sources/websearch.js";
import type { RawPost, RunInput, SourceCounts } from "./types.js";

// no .max() — the llm often returns a few extra; we slice downstream instead of throwing to fallback
const planSchema = z.object({
  subreddits: z.array(z.string()),
  youtubeQueries: z.array(z.string()),
  focusTopics: z.array(z.string()),
});
type Plan = z.infer<typeof planSchema>;

const fallbackPlan: Plan = {
  subreddits: ["CryptoCurrency", "Bitcoin", "ethereum", "CryptoMarkets", "solana", "defi"],
  youtubeQueries: ["crypto news this week", "bitcoin analysis"],
  focusTopics: ["bitcoin etf", "memecoins", "altcoins", "regulation", "layer 2s"],
};

// the agentic bit: llm decides WHERE to look + WHAT for (grounded by a live trend search),
// covering positive AND negative angles. code then does the actual fetching.
async function plan(input: RunInput, trends: string[], log: Logger): Promise<Plan> {
  if (!llmReady()) return fallbackPlan;
  try {
    const p = await askJSON(
      [
        sys(
          "you are a crypto content researcher. decide where to look for what's going viral RIGHT NOW. " +
            "pick crypto subreddits (plain names, no 'r/'), youtube search queries, and focus topics. " +
            "youtube queries MUST be short keyword searches a real person would type (2-4 words, e.g. 'bitcoin etf flows', 'ethereum etf', 'solana memecoins') — NOT long questions or sentences, or youtube returns nothing. " +
            "cover BOTH bullish and bearish/critical angles — no positivity bias. " +
            'return json: {"subreddits":[],"youtubeQueries":[],"focusTopics":[]}',
        ),
        user(
          `user focus: ${input.focus || "none (go broad)"}\nvibe: ${input.vibe}\n` +
            (trends.length ? `live trend signals:\n- ${trends.join("\n- ")}` : "no live trend feed — use your knowledge"),
        ),
      ],
      planSchema,
      { temperature: 0.6 },
    );
    log.debug({ plan: p }, "research plan");
    return { ...fallbackPlan, ...p, subreddits: p.subreddits.length ? p.subreddits : fallbackPlan.subreddits };
  } catch (e) {
    log.warn({ err: String(e) }, "plan failed, using fallback");
    return fallbackPlan;
  }
}

function normalize(posts: RawPost[]): RawPost[] {
  for (const src of ["reddit", "youtube", "news"] as const) {
    const group = posts.filter((p) => p.source === src);
    if (src === "news") group.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    else group.sort((a, b) => b.engagement - a.engagement);
    group.forEach((p, i) => (p.virality = group.length > 1 ? Math.round(100 * (1 - i / (group.length - 1))) : 80));
  }
  return posts;
}

export async function research(input: RunInput, log: Logger): Promise<{ posts: RawPost[]; counts: SourceCounts }> {
  const trends = llmReady()
    ? await trendSearch(`trending crypto narratives and viral content this week ${input.focus ?? ""}`.trim())
    : [];
  const p = await plan(input, trends, log);
  const [reddit, news, youtube] = await Promise.all([fromReddit(p.subreddits), fromNews(), fromYoutube(p.youtubeQueries)]);

  const seen = new Set<string>();
  const merged = [...reddit, ...youtube, ...news].filter((x) => x.url && !seen.has(x.url) && seen.add(x.url));
  const top = normalize(merged)
    .sort((a, b) => b.virality - a.virality)
    .slice(0, 40);

  const counts: SourceCounts = {
    scanned: reddit.length + youtube.length + news.length,
    reddit: reddit.length,
    youtube: youtube.length,
    news: news.length,
    websearch: trends.length,
    x: null, // x/twitter not wired (paid api)
  };
  log.info({ ...counts, kept: top.length }, "research done");
  return { posts: top, counts };
}

import type { Logger } from "pino";
import { askJSON, sys, user, z } from "./llm.js";
import type { Insights, RawPost, RunInput } from "./types.js";
import { mockInsights } from "./mock.js";

const schema = z.object({
  mood: z.string(),
  viralHooks: z.array(z.string()),
  topics: z.array(z.string()),
  structures: z.array(z.string()),
  narratives: z.array(z.string()),
  trendingWeb3: z.array(z.string()),
});

const digest = (posts: RawPost[]) =>
  posts
    .map((p, i) => `${i + 1}. [${p.source} v${p.virality}] ${p.title}${p.summary ? ` — ${p.summary.slice(0, 120)}` : ""}`)
    .join("\n");

export async function analyze(posts: RawPost[], input: RunInput, log: Logger): Promise<{ insights: Insights; mock: boolean }> {
  if (!posts.length) return { insights: mockInsights, mock: true };
  try {
    const insights = await askJSON(
      [
        sys(
          "you analyze viral crypto content and extract reusable patterns. be data-backed and UNBIASED — surface both bullish and bearish/critical signals, since negativity drives reach too. ground everything in the posts given. " +
            'return json {mood,viralHooks,topics,structures,narratives,trendingWeb3}.',
        ),
        user(`vibe focus: ${input.vibe}\n\nviral posts (sorted by virality):\n${digest(posts)}`),
      ],
      schema,
      { temperature: 0.5 },
    );
    log.info({ hooks: insights.viralHooks.length, topics: insights.topics.length }, "analyze done");
    return { insights, mock: false };
  } catch (e) {
    log.warn({ err: String(e) }, "analyze fell back to mock");
    return { insights: mockInsights, mock: true };
  }
}

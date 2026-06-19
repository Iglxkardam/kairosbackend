import { z } from "zod";

export const runInput = z.object({
  focus: z.string().trim().max(120).optional(), // optional steer: a coin/topic/angle
  vibe: z.enum(["auto", "educational", "contrarian", "fear", "hype", "story"]).default("auto"),
  platform: z.enum(["all", "reel", "youtube", "thread"]).default("all"),
});
export type RunInput = z.infer<typeof runInput>;

export const thumbInput = z.object({
  id: z.string().max(64),
  format: z.enum(["reel", "youtube"]),
  hook: z.string().max(500),
  topic: z.string().max(500).default(""),
});

export interface RawPost {
  source: "reddit" | "youtube" | "news";
  title: string;
  summary?: string;
  url: string;
  engagement: number; // raw (upvotes / views / 0 for news)
  virality: number; // normalized 0-100 within its source
  publishedAt?: string;
}

export type Format = "reel" | "youtube" | "thread";
export type Vibe = "educational" | "contrarian" | "fear" | "hype" | "story";

export interface Insights {
  mood: string;
  viralHooks: string[];
  topics: string[];
  structures: string[];
  narratives: string[];
  trendingWeb3: string[];
}

export interface Idea {
  id: string;
  format: Format;
  vibe: Vibe;
  hook: string;
  topic: string;
  angle: string;
  script: string[];
  hashtags: string[];
  caption: string; // reel: ig caption · youtube: description · thread: one-line summary
  source?: { label: string; url: string };
}

export interface SourceCounts {
  scanned: number; // total fetched across sources
  reddit: number;
  youtube: number;
  news: number;
  websearch: number;
  x: number | null; // null = source not wired (no api)
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  llmCalls: number;
  costUsd: number;
}

export interface Result {
  insights: Insights;
  ideas: Idea[]; // 5 reels + 3 youtube + 3 threads
  meta: {
    runId: string;
    collected: number;
    bySource: SourceCounts;
    usedMock: boolean;
    ms: number;
    agent: Usage; // text pipeline (plan + grounding + analyze + generate). images add on the client.
  };
}

import type { Idea, Insights } from "./types.js";

export const mockInsights: Insights = {
  mood: "market mood: cautious greed — caution/contrarian hooks are outperforming pure hype this week.",
  viralHooks: [
    "the data says the opposite of what your timeline thinks",
    "here's what nobody is telling you about ___",
    "this one mistake cost them everything",
  ],
  topics: ["spot ETF flows", "memecoin rotation", "restaking / L2s", "stablecoin regulation"],
  structures: ["problem → insight → proof → solution", "loss → lesson", "secret reveal"],
  narratives: ["smart money vs retail", "institutions are (half) coming", "this cycle rhymes with 2017"],
  trendingWeb3: ["DePIN", "restaking", "AI agents", "BTC layer 2s"],
};

const seed: Omit<Idea, "id" | "hashtags" | "caption">[] = [
  { format: "reel", vibe: "contrarian", hook: "everyone's calling the top — on-chain says otherwise", topic: "exchange outflows vs CT panic", angle: "one chart: coins leaving exchanges while the timeline screams sell", script: ["0-3s: red candles vs green outflow chart", "3-15s: whales buy the fear, the proof", "15-25s: the one number that matters", "25-30s: watch what they do, not what they say"] },
  { format: "reel", vibe: "fear", hook: "this 'safe' 18% yield ate ₹4L in a week", topic: "stablecoin depeg risk", angle: "the collapse, then 3 red flags to catch the next one", script: ["0-4s: the yield, then the crash", "4-18s: what actually broke", "18-28s: 3 red flags", "28-32s: if the yield can't explain itself, it's the exit"] },
  { format: "reel", vibe: "educational", hook: "spot ETF inflows in 30 seconds", topic: "btc etf flows", angle: "no-jargon explainer with this week's real figure", script: ["0-3s: you keep seeing this number", "3-20s: inflows = real money in", "20-30s: this week's figure + what to watch"] },
  { format: "reel", vibe: "hype", hook: "last time this pattern showed up, it ran 4x", topic: "liquidity + halving cycle", angle: "fast montage, honest 'not financial advice' end", script: ["0-2s: remember 2020?", "2-15s: then-vs-now charts", "15-25s: one similarity, one difference", "25-30s: history rhymes"] },
  { format: "reel", vibe: "story", hook: "he went all-in on a memecoin — week 2 looked like this", topic: "memecoin psychology", angle: "narrated cautionary arc, real numbers, lesson", script: ["0-4s: day 1 up 60%, he told everyone", "4-18s: the slow bleed", "18-28s: where it ended + the lesson", "28-32s: the trade was fine, the size wasn't"] },
  { format: "youtube", vibe: "educational", hook: "i tracked every crypto narrative for 7 days — here's what's trending", topic: "narrative tracking", angle: "data-led, screen-recorded ranking", script: ["intro: the question", "method + sources", "the ranking with examples", "what it means next"] },
  { format: "youtube", vibe: "contrarian", hook: "why 'institutions are coming' is only half true", topic: "institutional adoption", angle: "steelman then counter with sources on screen", script: ["the bull case stated fairly", "the part nobody quotes", "what the filings say", "a more honest take"] },
  { format: "youtube", vibe: "story", hook: "the 2017 mistake everyone is about to repeat", topic: "cycle psychology", angle: "archival clips paralleled to now", script: ["late 2017 euphoria", "the exact mistake, with receipts", "the same signals today", "how to not be the example"] },
  { format: "thread", vibe: "contrarian", hook: "unpopular take: most 'alpha' accounts are lagging indicators", topic: "CT signal vs noise", angle: "5 tells an account is exit-liquidity bait", script: ["1/ why alpha feels late", "2-6/ the 5 tells, one each", "7/ what to follow instead"] },
  { format: "thread", vibe: "educational", hook: "a 6-tweet map of where crypto attention is flowing this week", topic: "attention flow", angle: "each tweet: topic + why it's heating + one data point", script: ["1/ the map in one line", "2-6/ one topic per tweet", "7/ the one to watch"] },
  { format: "thread", vibe: "fear", hook: "before you ape the next 'next big L1', read this", topic: "L1 due diligence", angle: "6 red-flag checklist, brutal and specific", script: ["1/ most L1s = a marketing budget", "2-7/ the 6 red flags", "8/ the green flags worth waiting for"] },
];

const tagsFor = (topic: string) =>
  [...new Set(["#crypto", "#web3", ...topic.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 3).slice(0, 3).map((w) => `#${w.replace(/[^a-z0-9]/g, "")}`)])]
    .filter((t) => t.length > 1)
    .slice(0, 6);

export const mockIdeas = (): Idea[] =>
  seed.map((s, i) => ({ ...s, id: `m${i}`, hashtags: tagsFor(s.topic), caption: s.angle }));

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { askJSON, sys, user, z } from "./llm.js";
import type { Format, Idea, Insights, RawPost, RunInput, Vibe } from "./types.js";
import { mockIdeas } from "./mock.js";

// keep parsing lenient — llms wander off enums/types; normalize instead of throwing (which would dump us to mock)
const rawIdea = z.object({
  format: z.string(),
  vibe: z.string().optional(),
  hook: z.string(),
  topic: z.string().default(""),
  angle: z.string().default(""),
  script: z.union([z.array(z.string()), z.string()]).optional(),
  hashtags: z.union([z.array(z.string()), z.string()]).optional(),
  caption: z.string().optional(),
  sourceUrl: z.string().optional(),
});
const outSchema = z.object({ ideas: z.array(rawIdea) });

const VIBES: Vibe[] = ["educational", "contrarian", "fear", "hype", "story"];
function normFormat(s: string): Format {
  const v = s.toLowerCase();
  if (v.includes("reel") || v.includes("insta")) return "reel";
  if (v.includes("youtube") || v.includes("video")) return "youtube";
  return "thread";
}
const normVibe = (s?: string): Vibe => (VIBES as string[]).includes((s ?? "").toLowerCase()) ? ((s as string).toLowerCase() as Vibe) : "educational";
function normScript(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/\n+/)
      .map((l) => l.replace(/^\d+[\).\s-]+/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function normTags(v: unknown, topic: string): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/) : [];
  const tags = raw.map((t) => t.replace(/^#+/, "").replace(/[^a-z0-9]/gi, "")).filter(Boolean).map((t) => `#${t}`);
  const uniq = [...new Set(tags)].slice(0, 8);
  if (uniq.length) return uniq;
  // fallback so a card never has zero tags
  const fromTopic = topic.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 3).slice(0, 3).map((w) => `#${w.replace(/[^a-z0-9]/g, "")}`);
  return [...new Set(["#crypto", "#web3", ...fromTopic])].filter((t) => t.length > 1).slice(0, 6);
}

const BANNED = ["dive in", "game-changer", "in today's world", "unlock", "leverage", "delve", "elevate", "navigate the world"];

const refs = (posts: RawPost[]) => posts.slice(0, 20).map((p, i) => `${i + 1}. ${p.title} (${p.url})`).join("\n");
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
};

const id = () => randomUUID().slice(0, 8);

// trim to max counts — never pad with mock ideas (that made every run look identical)
function trimCounts(ideas: Idea[]): Idea[] {
  const max: Record<Format, number> = { reel: 5, youtube: 3, thread: 3 };
  const out: Idea[] = [];
  for (const f of ["reel", "youtube", "thread"] as Format[]) {
    out.push(...ideas.filter((i) => i.format === f).slice(0, max[f]));
  }
  return out;
}

export async function generate(
  insights: Insights,
  posts: RawPost[],
  input: RunInput,
  log: Logger,
): Promise<{ ideas: Idea[]; mock: boolean }> {
  try {
    const want = input.platform === "all" ? "exactly 5 instagram reels, 3 youtube videos, and 3 twitter threads" : `8-11 ${input.platform} ideas`;
    const out = await askJSON(
      [
        sys(
          `you are a top crypto content strategist for an indian crypto-education brand. write ${want}. ` +
            "each idea: hook, topic, angle, and script as an array of 3-5 short beat strings. " +
            "for a reel each beat is a scene (e.g. '0-3s: ...'); for youtube each beat is a section (intro/point/outro); for a thread each beat is one tweet. " +
            "also give 5-8 relevant hashtags (single words, no spaces) and a ready-to-post caption (reel = instagram caption, youtube = 2-3 sentence description, thread = one-line summary). " +
            "ground ideas in the REAL posts provided and cite the closest one via sourceUrl. " +
            "CONSISTENCY: every field of one idea must be about the SAME subject — the company/coin/person/event named in the hook is the exact one used in topic, angle, script and caption. never name BlackRock in the hook then Franklin Templeton in the script. don't swap entities mid-idea. " +
            "rules: be SPECIFIC (real events/numbers), put TENSION in every hook, rotate tone & emotion (cover positive AND negative/contrarian — not just hype), sound like a real creator not AI. " +
            `never use these phrases: ${BANNED.join(", ")}. return json {ideas:[{format,vibe,hook,topic,angle,script,hashtags,caption,sourceUrl}]}.`,
        ),
        user(
          `vibe: ${input.vibe}   focus: ${input.focus || "none"}\n\ninsights:\n${JSON.stringify(insights)}\n\nreal posts to ground in:\n${refs(posts)}`,
        ),
      ],
      outSchema,
      { temperature: 0.9, maxTokens: 12000 },
    );

    let ideas: Idea[] = out.ideas.map((i) => ({
      id: id(),
      format: normFormat(i.format),
      vibe: normVibe(i.vibe),
      hook: i.hook,
      topic: i.topic ?? "",
      angle: i.angle ?? "",
      script: normScript(i.script),
      hashtags: normTags(i.hashtags, i.topic ?? ""),
      caption: i.caption ?? "",
      source: i.sourceUrl ? { label: hostOf(i.sourceUrl), url: i.sourceUrl } : undefined,
    }));
    if (input.platform === "all") ideas = trimCounts(ideas);

    log.info({ count: ideas.length }, "generate done");
    return { ideas, mock: false };
  } catch (e) {
    log.warn({ err: String(e) }, "generate fell back to mock");
    return { ideas: mockIdeas(), mock: true };
  }
}

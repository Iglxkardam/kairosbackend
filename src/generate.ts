import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { askJSON, sys, user, z } from "./llm.js";
import type { Format, Idea, Insights, RawPost, RunInput, Vibe } from "./types.js";
import { mockIdeas } from "./mock.js";

// keep parsing lenient — llms wander off enums/types; normalize instead of throwing (which would dump us to mock)
// script fields stay z.any — llms return arrays, strings, or nest the variants in an object.
// never throw on shape; normalize in the mapping instead (a throw dumps the whole run to mock).
const rawIdea = z.object({
  format: z.string(),
  vibe: z.string().optional(),
  hook: z.string(),
  topic: z.string().default(""),
  angle: z.string().default(""),
  script: z.any().optional(),
  // reels carry the spoken script in three forms; other formats just use `script`
  scriptHinglish: z.any().optional(),
  scriptEnglish: z.any().optional(),
  scriptHindi: z.any().optional(),
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
    const want = input.platform === "all" ? "exactly 5 instagram reels, 3 youtube videos, and 3 twitter posts" : `8-11 ${input.platform} ideas`;
    const out = await askJSON(
      [
        sys(
          `you are the head content strategist for an indian crypto-education creator (think a sharp, contrarian "the sujal show" voice). write ${want}. ` +
            "each idea has: hook, topic, angle, script (array of strings), hashtags, caption, sourceUrl. format the script PER PLATFORM:\n" +
            "- reel: the ACTUAL spoken words he says to camera — one continuous monologue that genuinely FILLS ~30 seconds: ~110-140 words across 6-8 beats. each beat is a FULL spoken sentence (~12-20 words), NOT a short fragment. the middle beats must EXPLAIN — give the why, real context, a specific number/detail — so it feels rich, not a 5-line skeleton. NOT scene directions, NOT timestamps, NOT '0-3s:'. match HIS exact reel voice:\n" +
            "  • open in the first second with urgency or a hard number — no greeting, no intro, no 'hi guys' (e.g. 'sirf ek din bacha hai...', 'bitcoin ne abhi...').\n" +
            "  • drop a real number right after the hook, then remove one fear/barrier or raise the stakes, then unpack what it actually means for the viewer.\n" +
            "  • hinglish: hindi sentence structure + english for crypto/tech terms (ETF, volume, bitcoin, wallet). english noun + hindi verb ('fund launch kari hai', 'profit book kar lena').\n" +
            "  • address the viewer as aap/aapko — NEVER 'bhai'. connectors: to, aur, ye jo, na.\n" +
            "  • checklist or build-up rhythm where it fits ('pehle ye hua, fir ye, aur ab ye').\n" +
            "  • close with light FOMO + a keyword-comment CTA in his style ('aisi cheez bahot kam aati, samajhna hai to crypto comment kardo').\n" +
            "  • never: self-intro, backstory, jokes, slow corporate tone, 'follow for more'.\n" +
            "  give the SAME script in THREE forms as THREE SEPARATE TOP-LEVEL FIELDS — scriptHinglish, scriptEnglish, scriptHindi — each a flat array of strings. do NOT nest them inside `script` and do NOT use the `script` field at all for reels. all three must have the same 6-8 beats, same length & detail. scriptHinglish = roman, exactly how he talks. scriptEnglish = clean english translation. scriptHindi (for text-to-speech) = PURE DEVANAGARI: transliterate EVERY english/tech word into devanagari too (bitcoin→बिटकॉइन, crypto→क्रिप्टो, ETF→ई॰टी॰एफ़, institutional→इंस्टीट्यूशनल, on-chain→ऑन-चेन, comment→कमेंट). NEVER leave latin letters or ALL-CAPS tokens in scriptHindi — the voice would spell them out letter by letter.\n" +
            "- youtube: written in ENGLISH. script = 3-5 beats, each a section label + one line (intro hook / main points / outro).\n" +
            "- thread: written in ENGLISH (he posts on X in english — NEVER hinglish/hindi here). this is ONE single x post in the creator's signature style, NOT a multi-tweet thread. hook = a strong factual headline (the news/claim). script = 4-7 short STANDALONE lines, each a single concrete fact or data point with a real number where possible (one stat per line). the LAST script item is a punchy 2-4 word conviction closer (e.g. 'Real conviction.', 'Bullish.', 'Pay attention.'). no '1/' numbering, no threading words.\n" +
            "ONLY reels are in hinglish/hindi. threads and youtube are always english.\n" +
            "hashtags: 5-8 single words, no spaces. caption: reel = instagram caption, youtube = 2-3 sentence description, thread = one-line summary. " +
            "ground every idea in the REAL posts provided and cite the closest one via sourceUrl — numbers in threads must come from the real posts, never invented. " +
            "CONSISTENCY: every field of one idea is about the SAME subject — the company/coin/person/event named in the hook is the exact one used in topic, angle, script and caption. never name BlackRock in the hook then Franklin Templeton in the script. don't swap entities mid-idea. " +
            "rules: be SPECIFIC (real events/numbers), put TENSION in every hook, rotate tone & emotion (cover positive AND negative/contrarian — not just hype), sound like a real creator not AI. " +
            `never use these phrases: ${BANNED.join(", ")}. return json {ideas:[{format,vibe,hook,topic,angle,script,hashtags,caption,sourceUrl}]}.`,
        ),
        user(
          `vibe: ${input.vibe}   focus: ${input.focus || "none"}\n\ninsights:\n${JSON.stringify(insights)}\n\nreal posts to ground in:\n${refs(posts)}`,
        ),
      ],
      outSchema,
      { temperature: 0.9, maxTokens: 16000 },
    );

    let ideas: Idea[] = out.ideas.map((i) => {
      const format = normFormat(i.format);
      let variants: Idea["variants"];
      let script: string[];
      if (format === "reel") {
        // models sometimes nest the three forms inside script:{hinglish,english,hindi} instead of top-level
        const so = i.script && typeof i.script === "object" && !Array.isArray(i.script) ? (i.script as Record<string, unknown>) : null;
        const hinglish = normScript(i.scriptHinglish ?? so?.hinglish);
        const english = normScript(i.scriptEnglish ?? so?.english ?? so?.en);
        const hindi = normScript(i.scriptHindi ?? so?.hindi ?? so?.devanagari);
        const base = hinglish.length ? hinglish : english.length ? english : normScript(i.script);
        variants = {
          hinglish: hinglish.length ? hinglish : base,
          english: english.length ? english : base,
          hindi: hindi.length ? hindi : base,
        };
        script = variants.hinglish; // default display
      } else {
        script = normScript(i.script);
      }
      return {
        id: id(),
        format,
        vibe: normVibe(i.vibe),
        hook: i.hook,
        topic: i.topic ?? "",
        angle: i.angle ?? "",
        script,
        hashtags: normTags(i.hashtags, i.topic ?? ""),
        caption: i.caption ?? "",
        source: i.sourceUrl ? { label: hostOf(i.sourceUrl), url: i.sourceUrl } : undefined,
        variants,
      };
    });
    if (input.platform === "all") ideas = trimCounts(ideas);

    log.info({ count: ideas.length }, "generate done");
    return { ideas, mock: false };
  } catch (e) {
    log.warn({ err: String(e) }, "generate fell back to mock");
    return { ideas: mockIdeas(), mock: true };
  }
}

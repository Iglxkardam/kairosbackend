import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import { log } from "./log.js";
import type { Format, Usage } from "./types.js";
import { thumbGate } from "./ratelimit.js";

const r2Ready = () =>
  !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL);
export const thumbsReady = () => !!(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY) && r2Ready();

let s3: S3Client | null = null;
function client(): S3Client {
  s3 ??= new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
  });
  return s3;
}

type Ref = { mime: string; data: string };
const mimeOf = (f: string) => {
  const e = extname(f).toLowerCase();
  return e === ".png" ? "image/png" : e === ".webp" ? "image/webp" : "image/jpeg";
};

// read every image in the reference dir (up to 5) — more angles = better face consistency
let refCache: Ref[] | undefined;
async function references(): Promise<Ref[]> {
  if (refCache !== undefined) return refCache;
  try {
    const files = (await readdir(env.REFERENCE_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).slice(0, 5);
    refCache = await Promise.all(
      files.map(async (f) => ({ mime: mimeOf(f), data: (await readFile(join(env.REFERENCE_DIR, f))).toString("base64") })),
    );
    if (!refCache.length) log.warn({ dir: env.REFERENCE_DIR }, "no reference images — thumbnails will be faceless");
    else log.debug({ refs: refCache.length }, "loaded reference images");
  } catch (e) {
    refCache = [];
    log.warn({ err: String(e) }, "reference dir read failed — thumbnails faceless");
  }
  return refCache;
}

function prompt(format: Format, hook: string, topic: string): string {
  const who = "for an indian crypto-education creator. reference images of the creator are provided — feature his face accurately and consistently.";
  if (format === "reel")
    return `vertical 9:16 instagram reel cover ${who} bold punchy on-image text "${hook}". topic: ${topic}. expressive reaction, high-contrast, clean modern look.`;
  return `16:9 youtube thumbnail ${who} huge bold readable text "${hook}". topic: ${topic}. shocked/curious face, chart or crypto motif, high-contrast colors.`;
}

const IMG_COST = 0.039; // ballpark per image, used only when the provider omits cost

// gemini direct (generativelanguage) — reference photos go in as inlineData
type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiImgResp = {
  candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

async function genViaGemini(p: string, refs: Ref[]): Promise<{ img: Ref; usage: Usage }> {
  const parts: GeminiPart[] = [{ text: p }];
  for (const r of refs) parts.push({ inlineData: { mimeType: r.mime, data: r.data } });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"] } }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`gemini image ${r.status} ${(await r.text()).slice(0, 160)}`);
  const j = (await r.json()) as GeminiImgResp;
  const out = j.candidates?.[0]?.content?.parts?.find((x) => x.inlineData)?.inlineData;
  if (!out?.data) throw new Error("no image in response");
  const m = j.usageMetadata ?? {};
  return {
    img: { mime: out.mimeType ?? "image/png", data: out.data },
    usage: { tokensIn: m.promptTokenCount ?? 0, tokensOut: m.candidatesTokenCount ?? 0, totalTokens: m.totalTokenCount ?? 0, llmCalls: 1, costUsd: IMG_COST },
  };
}

// openrouter — chat/completions with modalities:["image","text"]; refs go in as image_url data urls,
// the generated image comes back as a base64 data url in message.images
type OrContent = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OrImgResp = {
  choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
};

async function genViaOpenRouter(p: string, refs: Ref[]): Promise<{ img: Ref; usage: Usage }> {
  const content: OrContent[] = [{ type: "text", text: p }];
  for (const r of refs) content.push({ type: "image_url", image_url: { url: `data:${r.mime};base64,${r.data}` } });
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://kairos.app",
      "X-Title": "Kairos",
    },
    body: JSON.stringify({ model: env.IMAGE_MODEL, messages: [{ role: "user", content }], modalities: ["image", "text"] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`openrouter image ${r.status} ${(await r.text()).slice(0, 160)}`);
  const j = (await r.json()) as OrImgResp;
  const m = j.choices?.[0]?.message?.images?.[0]?.image_url?.url?.match(/^data:(.+?);base64,(.+)$/);
  if (!m) throw new Error("no image in response");
  const u = j.usage ?? {};
  return {
    img: { mime: m[1]!, data: m[2]! },
    usage: { tokensIn: u.prompt_tokens ?? 0, tokensOut: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0, llmCalls: 1, costUsd: u.cost ?? IMG_COST },
  };
}

// model id with a "/" (e.g. google/gemini-3.1-flash-image) → openrouter, else gemini direct
async function gen(p: string): Promise<{ img: Ref; usage: Usage } | null> {
  const refs = await references();
  return env.IMAGE_MODEL.includes("/") && env.OPENROUTER_API_KEY
    ? genViaOpenRouter(p, refs)
    : genViaGemini(p, refs);
}

// cap concurrent gens so 8 cards don't all hit the model at once (that throttling caused 60s stalls)
const MAX_GEN = 4;
let active = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_GEN) await new Promise<void>((r) => waiters.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

// dedupe in-flight gens by key so a retry (or two cards) never generates the same image twice
const inflight = new Map<string, Promise<{ url: string | null; usage?: Usage }>>();

export async function thumbnail(
  format: Format,
  hook: string,
  topic: string,
  id: string,
  ip: string,
): Promise<{ url: string | null; usage?: Usage }> {
  if (!thumbsReady()) return { url: null };
  const key = `thumbs/${createHash("sha1").update(`${id}:${format}:${hook}`).digest("hex").slice(0, 16)}.webp`;
  const url = `${env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;

  // already on r2? reuse it — instant, no regen, no tokens, NO rate limit (this is every reload / history view)
  try {
    await client().send(new HeadObjectCommand({ Bucket: env.R2_BUCKET!, Key: key }));
    return { url };
  } catch {
    /* not there yet */
  }

  // a gen for this exact image already running? share it instead of kicking off a duplicate
  const running = inflight.get(key);
  if (running) return running;

  // only a genuinely NEW image generation counts against the abuse limit
  if (!thumbGate(ip)) return { url: null };

  const job = (async () => {
    try {
      const g = await withSlot(() => gen(prompt(format, hook, topic)));
      if (!g) return { url: null };
      // compress hard: downscale to card size + webp. a 4k png (~MBs) becomes ~30-70kb → loads instantly
      const width = format === "reel" ? 540 : 768;
      const webp = await sharp(Buffer.from(g.img.data, "base64"))
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 72, effort: 5 })
        .toBuffer();
      await client().send(
        new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, Body: webp, ContentType: "image/webp" }),
      );
      log.info({ key, kb: Math.round(webp.length / 1024) }, "thumbnail uploaded");
      return { url, usage: g.usage };
    } catch (e) {
      log.warn({ err: String(e) }, "thumbnail failed, using styled cover");
      return { url: null };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}

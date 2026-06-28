import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import { log } from "./log.js";
import { voiceGate } from "./ratelimit.js";

const r2set = () =>
  !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL);

const cartesia = () => !!(env.CARTESIA_API_KEY && env.CARTESIA_VOICE_ID);
const eleven = () => !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
export const voiceReady = () => r2set() && (env.VOICE_PROVIDER === "cartesia" ? cartesia() : eleven());

let s3: S3Client | null = null;
const client = () =>
  (s3 ??= new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
  }));

// dedupe in-flight synths by key so a double-click never bills two generations
const inflight = new Map<string, Promise<{ url: string | null }>>();

export async function voice(id: string, text: string, ip: string): Promise<{ url: string | null }> {
  const clean = text.trim().slice(0, 1200); // a 30s script is ~500 chars — keep cost bounded
  if (!voiceReady() || !clean) return { url: null };

  const voiceId = env.VOICE_PROVIDER === "cartesia" ? env.CARTESIA_VOICE_ID : env.ELEVENLABS_VOICE_ID;
  const key = `voice/${createHash("sha1").update(`${id}:${env.VOICE_PROVIDER}:${voiceId}:${clean}`).digest("hex").slice(0, 16)}.mp3`;
  const url = `${env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;

  // already synthesized? reuse — instant, no tokens, no gate (every replay / reload hits this)
  try {
    await client().send(new HeadObjectCommand({ Bucket: env.R2_BUCKET!, Key: key }));
    return { url };
  } catch {
    /* not there yet */
  }

  const running = inflight.get(key);
  if (running) return running;

  if (!voiceGate(ip)) return { url: null };

  const job = (async () => {
    try {
      const mp3 = env.VOICE_PROVIDER === "cartesia" ? await viaCartesia(clean) : await viaEleven(clean);
      await client().send(
        new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, Body: mp3, ContentType: "audio/mpeg" }),
      );
      log.info({ key, kb: Math.round(mp3.length / 1024) }, "voice uploaded");
      return { url };
    } catch (e) {
      log.warn({ err: String(e) }, "voice synth failed");
      return { url: null };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}

// cartesia sonic — clone speaks any language, so we feed devanagari hindi with language "hi"
async function viaCartesia(text: string): Promise<Buffer> {
  const r = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "X-API-Key": env.CARTESIA_API_KEY!,
      "Cartesia-Version": env.CARTESIA_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model_id: env.CARTESIA_MODEL,
      transcript: text,
      language: "hi",
      voice: { mode: "id", id: env.CARTESIA_VOICE_ID },
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`cartesia ${r.status} ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function viaEleven(text: string): Promise<Buffer> {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: env.ELEVENLABS_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (!r.ok) throw new Error(`elevenlabs ${r.status} ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}

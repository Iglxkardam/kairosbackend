import "dotenv/config";
import { z } from "zod";
import { log } from "./log.js";

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  FRONTEND_ORIGIN: z.string().default("*"),
  WINDOW_DAYS: z.coerce.number().default(30), // how far back to collect

  GEMINI_API_KEY: z.string().optional(),
  LLM_PRIMARY_MODEL: z.string().default("gemini-3.1-flash-lite"),
  OPENROUTER_API_KEY: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().default("deepseek/deepseek-v4-pro"),
  // which provider runs text first: "gemini" (default) or "openrouter"
  LLM_PROVIDER: z.enum(["gemini", "openrouter"]).default("gemini"),

  YOUTUBE_API_KEY: z.string().optional(),
  SEARCH_API_KEY: z.string().optional(),
  // reddit app-only oauth — needed for reddit to work from datacenter ips (railway)
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  NEWS_FEEDS: z
    .string()
    .default(
      "https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss,https://decrypt.co/feed,https://bitcoinmagazine.com/feed",
    ),

  PROXY_SECRET: z.string().optional(),

  // ai thumbnails (bonus) — gracefully off if r2 not configured
  IMAGE_MODEL: z.string().default("gemini-3.1-flash-image-preview"),
  REFERENCE_DIR: z.string().default("assets"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),

  // voice clone (bonus) — reads the reel's hindi script in the creator's cloned voice. off if unset.
  // swappable provider: cartesia (free credits, great hindi) or elevenlabs.
  VOICE_PROVIDER: z.enum(["cartesia", "elevenlabs"]).default("cartesia"),
  CARTESIA_API_KEY: z.string().optional(),
  CARTESIA_VOICE_ID: z.string().optional(),
  CARTESIA_MODEL: z.string().default("sonic-3"),
  CARTESIA_VERSION: z.string().default("2024-11-13"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default("eleven_multilingual_v2"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  log.fatal({ issues: parsed.error.flatten().fieldErrors }, "bad env");
  process.exit(1);
}

export const env = parsed.data;

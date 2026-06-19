import Parser from "rss-parser";
import { env } from "../env.js";
import type { RawPost } from "../types.js";
import { log } from "../log.js";

// public reddit json 403s from datacenter ips (railway/cloud). with a script-app client id/secret
// we use app-only oauth which is allowed from anywhere. then public json (browser ua), then rss
// (least blocked) as a last resort — rss carries no score, so those rank by feed order.
const UA = "kairos/1.0 by u/thesujalshow";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const rss = new Parser({ timeout: 15_000, headers: { "user-agent": BROWSER_UA, accept: "application/rss+xml, application/xml, text/xml" } });
const SUBS = ["CryptoCurrency", "Bitcoin", "ethereum", "CryptoMarkets", "solana", "defi"];

type Child = {
  data: { title?: string; selftext?: string; permalink?: string; ups?: number; num_comments?: number; created_utc?: number; stickied?: boolean };
};

let token: { value: string; exp: number } | null = null;
async function getToken(): Promise<string | null> {
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) return null;
  if (token && token.exp > Date.now()) return token.value;
  const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    log.warn({ status: r.status }, "reddit token failed");
    return null;
  }
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000 };
  return token.value;
}

async function topOf(sub: string, tok: string | null): Promise<RawPost[]> {
  const base = tok ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const headers: Record<string, string> = tok
    ? { authorization: `Bearer ${tok}`, "user-agent": UA }
    : { "user-agent": BROWSER_UA, accept: "application/json" };
  const r = await fetch(`${base}/r/${sub}/top.json?t=month&limit=30&raw_json=1`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`r/${sub} ${r.status}`);
  const j = (await r.json()) as { data?: { children?: Child[] } };
  return (j.data?.children ?? [])
    .map((c) => c.data)
    .filter((d) => !d.stickied && d.title)
    .map((d) => ({
      source: "reddit" as const,
      title: d.title!,
      summary: (d.selftext ?? "").slice(0, 280),
      url: `https://reddit.com${d.permalink ?? ""}`,
      engagement: (d.ups ?? 0) + (d.num_comments ?? 0),
      virality: 0,
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
    }));
}

// rss is the least-blocked path — no score in it, so these fall back to feed order
async function rssOf(sub: string): Promise<RawPost[]> {
  const feed = await rss.parseURL(`https://www.reddit.com/r/${sub}/top/.rss?t=month&limit=25`);
  return feed.items
    .slice(0, 20)
    .map((it) => ({
      source: "reddit" as const,
      title: it.title ?? "",
      summary: (it.contentSnippet ?? "").replace(/\s+/g, " ").slice(0, 280),
      url: it.link ?? "",
      engagement: 0,
      virality: 0,
      publishedAt: it.isoDate,
    }))
    .filter((p) => p.title && p.url);
}

// llm sometimes hands back "r/Bitcoin" or "/r/Bitcoin" — strip it so we don't hit /r/r/Bitcoin
const clean = (s: string) => s.trim().replace(/^\/?r\//i, "");

export async function fromReddit(subs: string[] = SUBS): Promise<RawPost[]> {
  const tok = await getToken();
  const picked = (subs.length ? subs : SUBS).map(clean).filter(Boolean).slice(0, 6);
  const batches = await Promise.all(
    picked.map((s) => topOf(s, tok).catch((e) => (log.warn({ sub: s, err: String(e) }, "reddit sub failed"), [] as RawPost[]))),
  );
  let all = batches.flat();
  let via = tok ? "oauth" : "json";

  // json blocked (datacenter ip, no creds)? scrape the rss feeds instead — usually gets through
  if (!all.length) {
    const rssBatches = await Promise.all(
      picked.map((s) => rssOf(s).catch((e) => (log.warn({ sub: s, err: String(e) }, "reddit rss failed"), [] as RawPost[]))),
    );
    all = rssBatches.flat();
    via = "rss";
  }

  log.debug({ subs: picked.length, posts: all.length, via }, "reddit collected");
  return all;
}

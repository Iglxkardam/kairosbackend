import Parser from "rss-parser";
import { env } from "../env.js";
import type { RawPost } from "../types.js";
import { log } from "../log.js";

const parser = new Parser({
  timeout: 15_000,
  headers: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    accept: "application/rss+xml, application/xml, text/xml",
  },
});

const FEEDS = env.NEWS_FEEDS.split(",").map((s) => s.trim()).filter(Boolean);

export async function fromNews(): Promise<RawPost[]> {
  const batches = await Promise.all(
    FEEDS.map((f) =>
      parser
        .parseURL(f)
        .then((feed) =>
          feed.items.slice(0, 12).map((it) => ({
            source: "news" as const,
            title: it.title ?? "",
            summary: (it.contentSnippet ?? "").slice(0, 280),
            url: it.link ?? "",
            engagement: 0, // news has no public engagement; ranked by recency + cross-source repeat
            virality: 0,
            publishedAt: it.isoDate,
          })),
        )
        .catch((e) => (log.warn({ feed: f, err: String(e) }, "news feed failed"), [] as RawPost[])),
    ),
  );
  const all = batches.flat().filter((p) => p.title && p.url);
  log.debug({ feeds: FEEDS.length, items: all.length }, "news collected");
  return all;
}

import { env } from "../env.js";
import type { RawPost } from "../types.js";
import { log } from "../log.js";

type SearchItem = { id?: { videoId?: string } };
type Video = {
  id: string;
  snippet?: { title?: string; description?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
};

async function idsFor(query: string): Promise<string[]> {
  const after = new Date(Date.now() - env.WINDOW_DAYS * 864e5).toISOString();
  const u = new URL("https://www.googleapis.com/youtube/v3/search");
  u.search = new URLSearchParams({
    key: env.YOUTUBE_API_KEY!,
    q: query,
    part: "snippet",
    type: "video",
    order: "viewCount",
    publishedAfter: after,
    maxResults: "8",
  }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`yt search ${r.status}`);
  const j = (await r.json()) as { items?: SearchItem[] };
  return (j.items ?? []).map((i) => i.id?.videoId).filter((x): x is string => !!x);
}

async function stats(ids: string[]): Promise<RawPost[]> {
  if (!ids.length) return [];
  const u = new URL("https://www.googleapis.com/youtube/v3/videos");
  u.search = new URLSearchParams({ key: env.YOUTUBE_API_KEY!, id: ids.join(","), part: "snippet,statistics" }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`yt videos ${r.status}`);
  const j = (await r.json()) as { items?: Video[] };
  return (j.items ?? []).map((v) => {
    const s = v.statistics ?? {};
    return {
      source: "youtube" as const,
      title: v.snippet?.title ?? "",
      summary: (v.snippet?.description ?? "").slice(0, 280),
      url: `https://youtube.com/watch?v=${v.id}`,
      engagement: +(s.viewCount ?? 0) + +(s.likeCount ?? 0) * 20 + +(s.commentCount ?? 0) * 30,
      virality: 0,
    };
  });
}

export async function fromYoutube(queries: string[]): Promise<RawPost[]> {
  if (!env.YOUTUBE_API_KEY) return [];
  const search = async (qs: string[]) => {
    const idLists = await Promise.all(
      qs.map((q) => idsFor(q).catch((e) => (log.warn({ q, err: String(e) }, "yt search failed"), [] as string[]))),
    );
    return stats([...new Set(idLists.flat())]);
  };
  try {
    let out = await search((queries.length ? queries : ["crypto news", "bitcoin"]).slice(0, 2));
    // planned queries are sometimes too niche for the 30-day window → broaden once before giving up
    if (!out.length) out = await search(["crypto news this week", "bitcoin price analysis"]);
    log.debug({ videos: out.length }, "youtube collected");
    return out;
  } catch (e) {
    log.warn({ err: String(e) }, "youtube failed");
    return [];
  }
}

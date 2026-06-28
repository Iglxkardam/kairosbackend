// in-memory limiter (no db). single railway instance → fine; at scale this moves to redis.
// two layers: PER-IP (fair use) + GLOBAL (a cost circuit-breaker that holds even if someone rotates ips).
// the generate limit fires ONLY on a completed run — a failed/aborted run frees the slot.

const WINDOW_MS = 10 * 60_000;
const PER_IP_MAX = 10; // completed generations per 10 min per ip
const PENDING_TTL = 6 * 60_000; // a run can't legitimately outlive the 5-min run timeout

const GLOBAL_GEN_MAX = 150; // total runs/hour across everyone — caps spend under a distributed attack
const GLOBAL_WINDOW = 60 * 60_000;

type Rec = { count: number; windowAt: number; pendingAt: number };
const gen = new Map<string, Rec>();
let gGen = { n: 0, resetAt: 0 };

export type Gate = { ok: true } | { ok: false; retryAfter: number };

// reserve a slot before starting a run. check+set is synchronous → two racing requests can't both pass.
// also serializes per ip: one in-flight run at a time, so 10 racing requests can't all reserve.
export function startGen(ip: string): Gate {
  const now = Date.now();
  sweep(now);

  // global circuit breaker first — bounds total cost even if per-ip is dodged via ip rotation
  if (gGen.resetAt < now) gGen = { n: 0, resetAt: now + GLOBAL_WINDOW };
  if (gGen.n >= GLOBAL_GEN_MAX) return { ok: false, retryAfter: Math.ceil((gGen.resetAt - now) / 1000) };

  const r = gen.get(ip);
  const fresh = !r || now - r.windowAt >= WINDOW_MS;
  const count = fresh ? 0 : r!.count;
  const windowAt = fresh ? now : r!.windowAt;

  if (count >= PER_IP_MAX) return { ok: false, retryAfter: Math.ceil((windowAt + WINDOW_MS - now) / 1000) };
  if (r?.pendingAt && now - r.pendingAt < PENDING_TTL) {
    return { ok: false, retryAfter: Math.ceil((PENDING_TTL - (now - r.pendingAt)) / 1000) };
  }

  gen.set(ip, { count, windowAt, pendingAt: now });
  gGen.n += 1; // reserve a global slot
  return { ok: true };
}

// a real completed generation counts against the 10-min window (global slot already counted at start)
export function genOk(ip: string) {
  const now = Date.now();
  const r = gen.get(ip);
  const fresh = !r || now - r.windowAt >= WINDOW_MS;
  gen.set(ip, { count: (fresh ? 0 : r!.count) + 1, windowAt: fresh ? now : r!.windowAt, pendingAt: 0 });
}

// a failed run frees the pending slot AND the global slot — failures never burn quota
export function genFail(ip: string) {
  const r = gen.get(ip);
  if (r) gen.set(ip, { ...r, pendingAt: 0 });
  gGen.n = Math.max(0, gGen.n - 1);
}

function sweep(now: number) {
  for (const [k, v] of gen) {
    if (now - v.windowAt >= WINDOW_MS && (!v.pendingAt || now - v.pendingAt > PENDING_TTL)) gen.delete(k);
  }
}

// caps only NEW image generations (cache hits / reloads / history views never reach here).
// per-ip stops one client; the global cap stops an ip-rotating flood from running up the image bill.
const THUMB_MAX = 30;
const THUMB_WINDOW = 10 * 60_000;
const GLOBAL_THUMB_MAX = 200; // new images/hour across everyone
const thumbs = new Map<string, { n: number; resetAt: number }>();
let gThumb = { n: 0, resetAt: 0 };

export function thumbGate(ip: string): boolean {
  const now = Date.now();
  if (gThumb.resetAt < now) gThumb = { n: 0, resetAt: now + GLOBAL_WINDOW };
  if (gThumb.n >= GLOBAL_THUMB_MAX) return false;

  const r = thumbs.get(ip);
  if (!r || r.resetAt < now) {
    thumbs.set(ip, { n: 1, resetAt: now + THUMB_WINDOW });
    gThumb.n += 1;
    return true;
  }
  if (r.n >= THUMB_MAX) return false;
  r.n += 1;
  gThumb.n += 1;
  return true;
}

// same shape as thumbGate — only NEW voice synth reaches here (cached replays skip it)
const VOICE_MAX = 20;
const GLOBAL_VOICE_MAX = 120;
const voices = new Map<string, { n: number; resetAt: number }>();
let gVoice = { n: 0, resetAt: 0 };

export function voiceGate(ip: string): boolean {
  const now = Date.now();
  if (gVoice.resetAt < now) gVoice = { n: 0, resetAt: now + GLOBAL_WINDOW };
  if (gVoice.n >= GLOBAL_VOICE_MAX) return false;

  const r = voices.get(ip);
  if (!r || r.resetAt < now) {
    voices.set(ip, { n: 1, resetAt: now + THUMB_WINDOW });
    gVoice.n += 1;
    return true;
  }
  if (r.n >= VOICE_MAX) return false;
  r.n += 1;
  gVoice.n += 1;
  return true;
}

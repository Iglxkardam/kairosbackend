import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./env.js";
import { log } from "./log.js";
import { runInput, thumbInput, voiceInput } from "./types.js";
import { run } from "./pipeline.js";
import { thumbnail } from "./image.js";
import { voice } from "./voice.js";
import { createJob, failJob, finishJob, getJob } from "./jobs.js";
import { startGen, genOk, genFail } from "./ratelimit.js";

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

// the proxy forwards the real client ip (it's trusted — only the proxy holds the secret)
const clientIp = (req: { headers: Record<string, unknown>; ip: string }) =>
  (typeof req.headers["x-client-ip"] === "string" && req.headers["x-client-ip"]) || req.ip || "unknown";

await app.register(cors, {
  origin: env.FRONTEND_ORIGIN === "*" ? true : env.FRONTEND_ORIGIN.split(","),
});

// one tidy line per request — easy to scan in railway logs
app.addHook("onResponse", async (req, reply) => {
  log.info({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "req");
});

// only our frontend proxy (which adds the shared secret) may hit the api.
// health stays open for railway's checks.
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/health") return;
  if (env.PROXY_SECRET && req.headers["x-proxy-secret"] !== env.PROXY_SECRET) {
    log.warn({ ip: req.ip, url: req.url }, "blocked: bad proxy secret");
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => ({ ok: true }));

// start a run in the background, return a jobId immediately. the run survives a client
// reload — the frontend polls /job/:id with the jobId it stashed in localStorage.
app.post("/generate", async (req, reply) => {
  const parsed = runInput.safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "bad input", issues: parsed.error.flatten().fieldErrors });

  // 1 completed generation / 10 min per ip. the slot is reserved now and only LOCKED on success;
  // a failed run frees it so the user isn't punished for our error.
  const ip = clientIp(req);
  const gate = startGen(ip);
  if (!gate.ok) {
    return reply.code(429).header("retry-after", String(gate.retryAfter)).send({ error: "rate_limited", retryAfter: gate.retryAfter });
  }

  const jobId = createJob();
  void (async () => {
    const timer = new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error("run timeout")), 5 * 60_000);
      t.unref(); // safety net so a job can never hang forever, but don't keep the process alive
    });
    try {
      finishJob(jobId, await Promise.race([run(parsed.data), timer]));
      genOk(ip); // real completion → lock the window
    } catch (e) {
      log.error({ err: String(e) }, "generate failed");
      failJob(jobId, "generation failed");
      genFail(ip); // failure → free the slot, no penalty
    }
  })();
  return { jobId };
});

app.get<{ Params: { id: string } }>("/job/:id", async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) return reply.code(404).send({ status: "missing" });
  return job;
});

// lazy ai thumbnail for a single card — returns { url } or { url: null } (frontend keeps styled cover)
app.post("/thumbnail", async (req) => {
  const parsed = thumbInput.safeParse(req.body ?? {});
  if (!parsed.success) return { url: null }; // graceful — card just keeps its styled cover
  // gate lives inside thumbnail() so it only counts NEW gens, never cache hits (reloads/history)
  return await thumbnail(parsed.data.format, parsed.data.hook, parsed.data.topic, parsed.data.id, clientIp(req));
});

// reads a reel script aloud in the creator's cloned voice — { url } (mp3 on r2) or { url: null }
app.post("/voice", async (req) => {
  const parsed = voiceInput.safeParse(req.body ?? {});
  if (!parsed.success) return { url: null };
  return await voice(parsed.data.id, parsed.data.text, clientIp(req));
});

try {
  const addr = await app.listen({ port: env.PORT, host: "0.0.0.0" });
  log.info({ addr }, "kairos backend up");
} catch (e) {
  log.error({ err: String(e) }, "listen failed");
  process.exit(1);
}

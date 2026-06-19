import { z, type ZodType } from "zod";
import { env } from "./env.js";
import { log } from "./log.js";

type Msg = { role: "system" | "user" | "assistant"; content: string };
type Provider = { name: string; baseURL: string; key: string; model: string; headers?: Record<string, string> };

function providers(): Provider[] {
  const out: Provider[] = [];
  if (env.GEMINI_API_KEY)
    out.push({
      name: "gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      key: env.GEMINI_API_KEY,
      model: env.LLM_PRIMARY_MODEL,
    });
  if (env.OPENROUTER_API_KEY)
    out.push({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      key: env.OPENROUTER_API_KEY,
      model: env.LLM_FALLBACK_MODEL,
      headers: { "HTTP-Referer": "https://kairos.app", "X-Title": "Kairos" },
    });
  return out;
}

export const llmReady = () => providers().length > 0;

export class LlmError extends Error {}

export type AgentUsage = {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  llmCalls: number;
  costUsd: number;
};

type AskOpts = { json?: boolean; temperature?: number; maxTokens?: number };

let runUsage: AgentUsage | null = null;

export function beginRunUsage() {
  runUsage = { tokensIn: 0, tokensOut: 0, totalTokens: 0, llmCalls: 0, costUsd: 0 };
}

export function snapshotUsage(): AgentUsage {
  return runUsage ?? { tokensIn: 0, tokensOut: 0, totalTokens: 0, llmCalls: 0, costUsd: 0 };
}

function parseUsage(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, number | undefined>;
  const tokensIn = u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0;
  const tokensOut = u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0;
  const totalTokens = u.total_tokens ?? u.totalTokenCount ?? tokensIn + tokensOut;
  const costUsd = u.cost ?? u.total_cost;
  if (!tokensIn && !tokensOut && !totalTokens) return null;
  return { tokensIn, tokensOut, totalTokens, costUsd };
}

// rough $/1M tokens when the provider omits cost (gemini flash-lite ballpark)
function estimateCost(provider: string, model: string, tokensIn: number, tokensOut: number) {
  const m = model.toLowerCase();
  let inRate = 0.1;
  let outRate = 0.4;
  if (provider === "openrouter" || m.includes("deepseek")) {
    inRate = 0.27;
    outRate = 1.1;
  } else if (m.includes("flash-lite") || m.includes("flash")) {
    inRate = 0.075;
    outRate = 0.3;
  }
  return (tokensIn / 1_000_000) * inRate + (tokensOut / 1_000_000) * outRate;
}

export function recordUsage(raw: unknown, provider: string, model: string) {
  if (!runUsage) return;
  const u = parseUsage(raw);
  if (!u) return;
  runUsage.tokensIn += u.tokensIn;
  runUsage.tokensOut += u.tokensOut;
  runUsage.totalTokens += u.totalTokens;
  runUsage.llmCalls += 1;
  runUsage.costUsd += u.costUsd ?? estimateCost(provider, model, u.tokensIn, u.tokensOut);
}

export async function ask(messages: Msg[], opts: AskOpts = {}): Promise<string> {
  const ps = providers();
  if (!ps.length) throw new LlmError("no llm provider configured");

  let last: unknown;
  for (const p of ps) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${p.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.key}`, ...(p.headers ?? {}) },
        body: JSON.stringify({
          model: p.model,
          messages,
          temperature: opts.temperature ?? 0.7,
          max_tokens: opts.maxTokens ?? 4096,
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 240)}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: unknown };
      const text = data.choices?.[0]?.message?.content ?? "";
      recordUsage(data.usage, p.name, p.model);
      log.debug({ provider: p.name, model: p.model, ms: Math.round(performance.now() - t0), usage: data.usage }, "llm ok");
      return text;
    } catch (e) {
      last = e;
      log.warn({ provider: p.name, err: String(e) }, "llm provider failed, trying next");
    }
  }
  throw new LlmError(`all llm providers failed: ${String(last)}`);
}

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1]! : s).trim();
}

export async function askJSON<T>(messages: Msg[], schema: ZodType<T>, opts: AskOpts = {}): Promise<T> {
  const raw = await ask(messages, { ...opts, json: true });
  let obj: unknown;
  try {
    obj = JSON.parse(stripFences(raw));
  } catch {
    throw new LlmError(`llm returned non-json: ${raw.slice(0, 160)}`);
  }
  return schema.parse(obj);
}

export const sys = (content: string): Msg => ({ role: "system", content });
export const user = (content: string): Msg => ({ role: "user", content });
export { z };

import { randomUUID } from "node:crypto";
import { runLogger } from "./log.js";
import { llmReady, beginRunUsage, snapshotUsage } from "./llm.js";
import { research } from "./research.js";
import { analyze } from "./analyze.js";
import { generate } from "./generate.js";
import type { Result, RunInput } from "./types.js";

export async function run(input: RunInput): Promise<Result> {
  const runId = randomUUID().slice(0, 8);
  const log = runLogger(runId);
  const t0 = performance.now();
  log.info({ input, llm: llmReady() }, "run start");
  beginRunUsage();

  // pipeline 1 — collect (data stays in memory, handed straight to pipeline 2)
  const { posts, counts } = await research(input, log);

  // pipeline 2 — analyze then generate
  const a = await analyze(posts, input, log);
  const g = await generate(a.insights, posts, input, log);

  const ms = Math.round(performance.now() - t0);
  const result: Result = {
    insights: a.insights,
    ideas: g.ideas,
    meta: {
      runId,
      collected: posts.length,
      bySource: counts,
      usedMock: !llmReady() || a.mock || g.mock,
      ms,
      agent: snapshotUsage(),
    },
  };
  log.info({ ms, ideas: g.ideas.length, usedMock: result.meta.usedMock }, "run done");
  return result;
}

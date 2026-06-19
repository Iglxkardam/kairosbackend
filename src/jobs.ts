import { randomUUID } from "node:crypto";
import type { Result } from "./types.js";

// in-memory job store — survives a client reload mid-run (no DB). single-instance only;
// at scale this moves to redis. jobs self-expire after 30 min.
type Job = { status: "running" | "done" | "error"; result?: Result; error?: string; at: number };
const jobs = new Map<string, Job>();

function sweep() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [k, v] of jobs) if (v.at < cutoff) jobs.delete(k);
}

export function createJob(): string {
  const id = randomUUID().slice(0, 8);
  jobs.set(id, { status: "running", at: Date.now() });
  sweep();
  return id;
}

export const finishJob = (id: string, result: Result) => jobs.set(id, { status: "done", result, at: Date.now() });
export const failJob = (id: string, error: string) => jobs.set(id, { status: "error", error, at: Date.now() });
export const getJob = (id: string) => jobs.get(id);

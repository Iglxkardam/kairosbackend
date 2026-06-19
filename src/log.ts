import pino from "pino";

const dev = process.env.NODE_ENV !== "production";

export const log = pino({
  level: process.env.LOG_LEVEL ?? (dev ? "debug" : "info"),
  // pretty locally, raw json in prod so railway/aggregators can parse it
  transport: dev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } }
    : undefined,
});

// child logger scoped to one run so every line carries the runId — easy to grep
export const runLogger = (runId: string) => log.child({ runId });

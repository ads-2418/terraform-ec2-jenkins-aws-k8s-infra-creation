import pino from "pino";

/**
 * Structured JSON logs, shipped to CloudWatch in production -
 * docs/DEVELOPMENT.md §5 "Observability". Every request-scoped logger
 * should be a child of this with `requestId` bound, so log lines
 * correlate with docs/API.md §2's `error.requestId`.
 */
export const rootLogger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof rootLogger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return rootLogger.child(bindings);
}

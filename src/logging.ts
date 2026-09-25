/** 结构化日志（Pino JSON）与测试用静默日志。 */
import { pino } from "pino";
import type { Logger } from "./ports";

export function createLogger(opts?: { level?: string }): Logger {
  return pino({ level: opts?.level ?? "info" }) as unknown as Logger;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * 结构化协议调用：模型只允许返回符合 Schema 的 JSON。
 * 解析失败做有限重试（附带校验错误反馈），不重放有副作用的操作。
 */
import type { z } from "zod";
import type { Logger, ModelGateway, ModelRole } from "../ports";
import { extractJson } from "../protocols/json";

export interface StructuredCallOptions<T> {
  gateway: ModelGateway;
  role: ModelRole;
  system: string;
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  logger: Logger;
  maxRetries?: number;
}

export interface StructuredResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  attempts: number;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastRaw?: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export async function generateStructured<T>(opts: StructuredCallOptions<T>): Promise<StructuredResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;
  let prompt = opts.prompt;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let lastRaw = "";
  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const response = await opts.gateway.generate({ role: opts.role, system: opts.system, prompt });
    inputTokens += response.inputTokens ?? 0;
    outputTokens += response.outputTokens ?? 0;
    costUsd += response.costUsd ?? 0;
    lastRaw = response.text;

    try {
      const json = extractJson(response.text);
      const parsed = opts.schema.safeParse(JSON.parse(json));
      if (parsed.success) {
        return {
          value: parsed.data,
          inputTokens,
          outputTokens,
          costUsd,
          attempts: attempt,
        };
      }
      lastError = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    opts.logger.warn({ role: opts.role, attempt, error: lastError }, "结构化输出解析失败，重试");
    prompt = `${opts.prompt}\n\n---\n上一次输出无效（${lastError}）。请只输出修正后的完整 JSON 对象，不要包含任何其他文字。`;
  }

  throw new StructuredOutputError(
    `结构化输出解析失败（${maxRetries + 1} 次尝试）: ${lastError}`,
    maxRetries + 1,
    lastRaw,
  );
}

/**
 * 桥接服务封装（docs/v1.1/ui-api-contract.md）：
 * - REST：/api/status /api/chat /api/model /api/pause /api/resume /api/export /api/models
 * - SSE：GET /api/events?runId=&since=，断线自动重连并以最后 seq 作 since 补发
 */
import type { ModelRef, Stage, UIEventEnvelope } from "../protocols/ui-events";
import { isUIEventEnvelope } from "../protocols/ui-events";

/** 桥接服务 base URL，可用 VITE_BRIDGE_URL 覆盖（契约默认本地回环 4700）。 */
export const BRIDGE_URL: string = import.meta.env.VITE_BRIDGE_URL ?? "http://127.0.0.1:4700";

export type ChatAction = "inline" | "consult" | "review-context" | "post-task";
export const CHAT_ACTIONS: readonly ChatAction[] = ["inline", "consult", "review-context", "post-task"];

export type Channel = "planner" | "coder";
export type ModelScope = "task" | "project" | "global";
export type ConnectionState = "connecting" | "open" | "reconnecting";

/** GET /api/models 返回的模型（available/unavailableReason 为可选扩展，供灰置展示）。 */
export interface ModelInfo {
  providerID: string;
  id: string;
  name?: string;
  contextLength?: number;
  tools?: boolean;
  available?: boolean;
  unavailableReason?: string;
  reason?: string;
}

/** GET /api/status 响应。 */
export interface RunStatus {
  runId: string;
  state: string;
  stage: Stage;
  round: number;
  running: boolean;
  paused: boolean;
  models: { planner: ModelRef | null; coder: ModelRef | null };
}

export interface ChatReply {
  reply: string;
  action: ChatAction;
}

export interface SetModelResult {
  model: ModelRef | null;
  effectiveFrom: string;
}

export interface OkResult {
  ok: boolean;
}

export interface ExportResult {
  markdown: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network", `无法连接桥接服务 ${BRIDGE_URL}`);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = data as { error?: string; message?: string } | null;
    throw new ApiError(res.status, err?.error ?? "http_error", err?.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

function query(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return search.toString();
}

/** GET /api/status?runId= */
export function getStatus(runId: string): Promise<RunStatus> {
  return request<RunStatus>(`/api/status?${query({ runId })}`);
}

/** POST /api/chat —— 用户介入消息进入编排器介入策略。 */
export function postChat(runId: string, message: string): Promise<ChatReply> {
  return request<ChatReply>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ runId, message }),
  });
}

/** POST /api/model —— 三级优先级 scope，响应 effectiveFrom: "next-stage"。 */
export function postModel(channel: Channel, model: ModelRef | null, scope: ModelScope): Promise<SetModelResult> {
  return request<SetModelResult>("/api/model", {
    method: "POST",
    body: JSON.stringify({ channel, model, scope }),
  });
}

/** POST /api/pause */
export function pauseRun(runId: string, reason?: string): Promise<OkResult> {
  return request<OkResult>("/api/pause", {
    method: "POST",
    body: JSON.stringify(reason === undefined ? { runId } : { runId, reason }),
  });
}

/** POST /api/resume */
export function resumeRun(runId: string): Promise<OkResult> {
  return request<OkResult>("/api/resume", {
    method: "POST",
    body: JSON.stringify({ runId }),
  });
}

/** GET /api/export?runId= —— 过程导出（已脱敏 markdown）。 */
export function exportRun(runId: string): Promise<ExportResult> {
  return request<ExportResult>(`/api/export?${query({ runId })}`);
}

/** GET /api/models */
export function listModels(): Promise<ModelInfo[]> {
  return request<{ models: ModelInfo[] }>("/api/models").then((res) => res.models ?? []);
}

export interface EventSubscription {
  runId: string;
  /** 起始序号（补发游标）；0 表示从头回放。 */
  since: number;
  onEnvelope: (envelope: UIEventEnvelope) => void;
  onConnection?: (state: ConnectionState) => void;
}

/**
 * SSE 订阅：`GET /api/events?runId=&since=`。
 * 断线后按指数退避自动重连，并以已收到的最后 seq 作为 since 让服务端补发，
 * 保证事件不丢；乱序/重复由 store 按 seq 排序去重。
 * 返回取消订阅函数。
 */
export function subscribeEvents(sub: EventSubscription): () => void {
  const controller = new AbortController();
  let cancelled = false;
  let since = sub.since;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      controller.signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        resolve();
      });
    });

  async function connectLoop(): Promise<void> {
    let attempt = 0;
    while (!cancelled) {
      sub.onConnection?.(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const url = `${BRIDGE_URL}/api/events?${query({ runId: sub.runId, since: String(since) })}`;
        const res = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok) throw new ApiError(res.status, "sse_http", `事件流 HTTP ${res.status}`);
        if (!res.body) throw new ApiError(0, "sse_empty", "事件流无正文");
        sub.onConnection?.("open");
        attempt = 0;

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let sep = buffer.indexOf("\n\n");
          while (sep >= 0) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data.trim().length > 0) {
              try {
                const parsed: unknown = JSON.parse(data) as unknown;
                if (isUIEventEnvelope(parsed)) {
                  if (parsed.seq > since) since = parsed.seq;
                  sub.onEnvelope(parsed);
                }
              } catch {
                // 忽略非 JSON 的心跳/注释帧
              }
            }
            sep = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (cancelled) return;
      }
      if (cancelled) return;
      sub.onConnection?.("reconnecting");
      const delay = Math.min(8000, 1000 * 2 ** attempt);
      attempt += 1;
      await sleep(delay);
    }
  }

  void connectLoop();

  return () => {
    cancelled = true;
    controller.abort();
  };
}

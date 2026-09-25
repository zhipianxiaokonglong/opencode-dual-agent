/**
 * UI 通道适配器（v1.1 §4.1 ui-channel-adapter）：
 * 编排器事件 → UI 推送（含断线补发）+ UI 命令 → 运行控制。
 *
 * 依赖方向约束（§7）：本模块只依赖编排器接口与 UIEvent 协议，
 * 不依赖 OpenCode 内部实现；传输层（插件 RPC / SSE 桥）在外层装配。
 */
import type { Logger } from "../ports";
import type { ModelRef, UIEventEnvelope } from "../protocols/ui-event";
import type { EventBus } from "../orchestrator/event-bus";
import { redactValue } from "../security/redaction";

export type ModelChannelName = "planner" | "coder";
export type ModelScope = "task" | "project" | "global";

export interface RunStatus {
  runId: string;
  state: string;
  stage: string;
  round: number;
  running: boolean;
  paused: boolean;
  models: Record<string, ModelRef | null>;
}

/** 运行控制器：由编排器在启动时装配，UI 命令经此进入工作流。 */
export interface WorkflowController {
  status(): RunStatus;
  chat(message: string): Promise<{ reply: string; action: string }>;
  setModel(input: {
    channel: ModelChannelName;
    model: ModelRef | null;
    scope: ModelScope;
  }): { model: ModelRef | null; effectiveFrom: string };
  pause(reason?: string): void;
  resume(): void;
  exportMarkdown(): Promise<string>;
}

export type RpcHandlers = Record<
  string,
  (input: unknown, context: { error(type: string, message: string, data?: unknown): never; signal?: AbortSignal }) => Promise<unknown>
>;

/**
 * UI 通道：维护活动运行注册表、事件扇出与 RPC 方法映射。
 */
export class UIChannel {
  readonly #runs = new Map<string, WorkflowController>();
  readonly #emitters = new Set<(envelope: UIEventEnvelope) => Promise<void>>();

  constructor(private readonly logger: Logger) {}

  /** 装配事件发射器（插件 RPC 的 events.emit）；多位置多实例可叠加。 */
  attachEmitter(emit: (envelope: UIEventEnvelope) => Promise<void>): () => void {
    this.#emitters.add(emit);
    return () => this.#emitters.delete(emit);
  }

  /** 编排器启动时注册控制器；返回注销函数。 */
  register(control: WorkflowController): () => void {
    this.#runs.set(control.status().runId, control);
    return () => this.#runs.delete(control.status().runId);
  }

  get(runId: string): WorkflowController | undefined {
    return this.#runs.get(runId);
  }

  /** EventBus 订阅入口：落库后的事件由此推给 UI（脱敏后推送，§8.1）。 */
  sink(): (envelope: UIEventEnvelope) => void {
    return (envelope) => {
      const redacted = redactValue(envelope);
      for (const listener of this.#allListeners) {
        try {
          listener(redacted);
        } catch {
          // 单个订阅者异常不影响其他订阅者
        }
      }
      for (const emit of this.#emitters) {
        void emit(redacted).catch((err: unknown) => {
          this.logger.warn({ err }, "UI 事件推送失败");
        });
      }
    };
  }

  /** 直接订阅某运行的事件流（SSE 桥用）；返回取消函数。 */
  subscribe(runId: string, listener: (envelope: UIEventEnvelope) => void): (() => void) | undefined {
    const bus = this.buses.get(runId);
    if (!bus) return undefined;
    return bus.subscribe((envelope) => listener(redactValue(envelope)));
  }

  /** 全局广播订阅（runId 发现：UI 先订阅全部，收到 run.started 后再定向订阅）。 */
  readonly #allListeners = new Set<(envelope: UIEventEnvelope) => void>();

  subscribeAll(listener: (envelope: UIEventEnvelope) => void): () => void {
    this.#allListeners.add(listener);
    return () => this.#allListeners.delete(listener);
  }

  /** 当前活动运行 ID 列表。 */
  listRuns(): string[] {
    return [...this.buses.keys()];
  }

  /** 供 RPC 注册的方法映射。 */
  handlers(): RpcHandlers {
    return {
      replay: async (input, ctx) => {
        const { runId, since } = input as { runId: string; since: number };
        const bus = this.busOf(runId);
        if (!bus) return ctx.error("run_not_found", "运行不存在或已结束", { runId });
        const events = redactValue(await bus.since(since));
        return { events, latest: events.length ? events[events.length - 1]!.seq : since };
      },
      status: async (input) => {
        const { runId } = input as { runId: string };
        const control = this.#runs.get(runId);
        return (
          control?.status() ?? {
            runId,
            state: "UNKNOWN",
            stage: "UNKNOWN",
            round: 0,
            running: false,
            paused: false,
            models: {},
          }
        );
      },
      chat: async (input) => {
        const { runId, message } = input as { runId: string; message: string };
        const control = this.#runs.get(runId);
        if (!control) throw new Error(`run_not_found: ${runId}`);
        return control.chat(message);
      },
      "model.set": async (input) => {
        const { runId, channel, model, scope } = input as {
          runId: string;
          channel: ModelChannelName;
          model: ModelRef | null;
          scope: ModelScope;
        };
        const control = this.#runs.get(runId);
        if (!control) throw new Error(`run_not_found: ${runId}`);
        return control.setModel({ channel, model, scope });
      },
      pause: async (input) => {
        const { runId, reason } = input as { runId: string; reason?: string };
        this.#runs.get(runId)?.pause(reason);
        return { ok: true };
      },
      resume: async (input) => {
        const { runId } = input as { runId: string };
        this.#runs.get(runId)?.resume();
        return { ok: true };
      },
      export: async (input) => {
        const { runId } = input as { runId: string };
        const control = this.#runs.get(runId);
        if (!control) throw new Error(`run_not_found: ${runId}`);
        return { markdown: await control.exportMarkdown() };
      },
    };
  }

  private buses = new Map<string, EventBus>();

  /** 运行的事件总线登记（补发查询用）。 */
  attachBus(runId: string, bus: EventBus): void {
    this.buses.set(runId, bus);
    void bus;
  }

  detachBus(runId: string): void {
    this.buses.delete(runId);
  }

  private busOf(runId: string): EventBus | undefined {
    return this.buses.get(runId);
  }
}

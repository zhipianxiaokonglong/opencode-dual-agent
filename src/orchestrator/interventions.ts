/**
 * 用户介入策略（v1.1 §5.2）：侧栏消息按工作流状态分类处理。
 * 规则：
 * - 思考模型对用户的回答不得直接执行代码修改，只能产出计划/建议（§5.2 规则 2）
 * - 介入消息走与用户需求相同的权限校验（§8.2）
 */
import type { WorkflowState } from "./transitions";

export type InterventionAction =
  /** 并入当前阶段，思考模型即时响应，不暂停 */
  | "inline"
  /** 进入 CONSULTING：安全点暂停后咨询，可选"应用到当前任务"或"仅咨询" */
  | "consult"
  /** 消息并入评审上下文 */
  | "review-context"
  /** 作为后续对话，可触发新一轮任务（需重新走 ANALYZING） */
  | "post-task";

export function classifyIntervention(state: WorkflowState): InterventionAction {
  switch (state) {
    case "ANALYZING":
    case "PLANNING":
    case "WAITING_USER":
    case "WAITING_APPROVAL":
      return "inline";
    case "IMPLEMENTING":
    case "VERIFYING":
    case "REPLANNING":
      return "consult";
    case "REVIEWING":
      return "review-context";
    case "COMPLETED":
    case "STOPPED":
    case "BLOCKED":
      return "post-task";
    case "CONSULTING":
      return "inline";
    case "CREATED":
    case "FINALIZING":
    case "CANCELLED":
    case "FAILED":
      return "post-task";
  }
}

/**
 * 暂停控制器：用户介入/点暂停时，工作流在**安全点**暂停
 * （不中断文件写入等原子操作，§5.2）。
 */
export class PauseController {
  #pauseRequested = false;
  #reason = "";
  #paused = false;
  #waiters: Array<() => void> = [];
  readonly #onPause?: (reason: string) => void | Promise<void>;
  readonly #onResume?: (reason: string) => void | Promise<void>;

  constructor(handlers: {
    onPause?: (reason: string) => void | Promise<void>;
    onResume?: (reason: string) => void | Promise<void>;
  } = {}) {
    this.#onPause = handlers.onPause;
    this.#onResume = handlers.onResume;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get reason(): string {
    return this.#reason;
  }

  /** 请求暂停：在下一个安全点生效。 */
  request(reason: string): void {
    this.#pauseRequested = true;
    this.#reason = reason;
  }

  /** 继续：解除暂停并唤醒等待者。 */
  resume(reason = "user-resumed"): void {
    this.#pauseRequested = false;
    this.#paused = false;
    this.#reason = "";
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
    void this.#onResume?.(reason);
  }

  /**
   * 安全点：若已请求暂停则挂起，直到 resume()。
   * 调用方应在原子操作之间调用（如每轮开始前、任务之间）。
   */
  async safePoint(label: string): Promise<void> {
    if (!this.#pauseRequested) return;
    this.#paused = true;
    await this.#onPause?.(this.#reason || label);
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

/**
 * 工作流状态机（§4）：显式转换表驱动，可恢复、可审计。
 * 禁止自由对话循环式跳转——任何状态变化必须走这张表。
 */

export const WORKFLOW_STATES = [
  "CREATED",
  "ANALYZING",
  "WAITING_USER",
  "PLANNING",
  "WAITING_APPROVAL",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "REPLANNING",
  "CONSULTING",
  "BLOCKED",
  "FINALIZING",
  "COMPLETED",
  "STOPPED",
  "CANCELLED",
  "FAILED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_EVENTS = [
  "START",
  "ANALYSIS_READY",
  "ANALYSIS_QUESTIONS",
  "USER_RESPONDED",
  "PLAN_READY",
  "PLAN_APPROVED",
  "PLAN_REJECTED",
  "IMPL_DONE",
  "VERIFY_DONE",
  "REVIEW_APPROVE",
  "REVIEW_FIXABLE",
  "REVIEW_REPLAN",
  "REVIEW_BLOCKED",
  "REVIEW_ASK",
  "REPLAN_DONE",
  "CONSULT_START",
  "CONSULT_RESUME_IMPL",
  "CONSULT_RESUME_VERIFY",
  "CONSULT_REPLAN",
  "FINALIZE_DONE",
  "BUDGET_EXCEEDED",
  "NO_PROGRESS",
  "CANCEL",
  "ERROR",
] as const;
export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

/** 活动状态可被 CANCEL / ERROR 打断。 */
const GLOBAL_INTERRUPTS: Partial<Record<WorkflowEvent, WorkflowState>> = {
  CANCEL: "CANCELLED",
  ERROR: "FAILED",
};

const TABLE: Record<WorkflowState, Partial<Record<WorkflowEvent, WorkflowState>>> = {
  CREATED: { START: "ANALYZING" },
  ANALYZING: {
    ANALYSIS_READY: "PLANNING",
    ANALYSIS_QUESTIONS: "WAITING_USER",
    BUDGET_EXCEEDED: "STOPPED",
  },
  WAITING_USER: {
    USER_RESPONDED: "PLANNING",
    BUDGET_EXCEEDED: "STOPPED",
  },
  PLANNING: {
    PLAN_READY: "WAITING_APPROVAL",
    BUDGET_EXCEEDED: "STOPPED",
  },
  WAITING_APPROVAL: {
    PLAN_APPROVED: "IMPLEMENTING",
    PLAN_REJECTED: "REPLANNING",
    BUDGET_EXCEEDED: "STOPPED",
    NO_PROGRESS: "STOPPED",
  },
  IMPLEMENTING: {
    IMPL_DONE: "VERIFYING",
    CONSULT_START: "CONSULTING",
    BUDGET_EXCEEDED: "STOPPED",
    NO_PROGRESS: "STOPPED",
  },
  VERIFYING: {
    VERIFY_DONE: "REVIEWING",
    CONSULT_START: "CONSULTING",
    BUDGET_EXCEEDED: "STOPPED",
    NO_PROGRESS: "STOPPED",
  },
  REVIEWING: {
    REVIEW_APPROVE: "FINALIZING",
    REVIEW_FIXABLE: "IMPLEMENTING",
    REVIEW_REPLAN: "REPLANNING",
    REVIEW_BLOCKED: "BLOCKED",
    REVIEW_ASK: "WAITING_USER",
    BUDGET_EXCEEDED: "STOPPED",
    NO_PROGRESS: "STOPPED",
  },
  REPLANNING: {
    REPLAN_DONE: "IMPLEMENTING",
    BUDGET_EXCEEDED: "STOPPED",
    NO_PROGRESS: "STOPPED",
  },
  CONSULTING: {
    CONSULT_RESUME_IMPL: "IMPLEMENTING",
    CONSULT_RESUME_VERIFY: "VERIFYING",
    CONSULT_REPLAN: "PLANNING",
  },
  BLOCKED: {},
  FINALIZING: { FINALIZE_DONE: "COMPLETED" },
  COMPLETED: {},
  STOPPED: {},
  CANCELLED: {},
  FAILED: {},
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: WorkflowState,
    readonly event: WorkflowEvent,
  ) {
    super(`非法状态转换: ${from} --${event}--> ?`);
    this.name = "IllegalTransitionError";
  }
}

export const TERMINAL_STATES: readonly WorkflowState[] = [
  "COMPLETED",
  "STOPPED",
  "CANCELLED",
  "FAILED",
];

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function nextState(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  const local = TABLE[state][event];
  if (local) return local;
  const global = isTerminal(state) ? undefined : GLOBAL_INTERRUPTS[event];
  if (global) return global;
  throw new IllegalTransitionError(state, event);
}

export interface TransitionRecord {
  from: WorkflowState;
  event: WorkflowEvent;
  to: WorkflowState;
  at: number;
}

export interface MachineSnapshot {
  state: WorkflowState;
  history: TransitionRecord[];
}

export class WorkflowMachine {
  #state: WorkflowState;
  #history: TransitionRecord[] = [];

  constructor(
    private readonly clock: () => number = () => Date.now(),
    initial?: MachineSnapshot,
  ) {
    this.#state = initial?.state ?? "CREATED";
    if (initial) this.#history = [...initial.history];
  }

  get state(): WorkflowState {
    return this.#state;
  }

  get history(): readonly TransitionRecord[] {
    return this.#history;
  }

  can(event: WorkflowEvent): boolean {
    try {
      nextState(this.#state, event);
      return true;
    } catch {
      return false;
    }
  }

  send(event: WorkflowEvent): WorkflowState {
    const to = nextState(this.#state, event);
    this.#history.push({ from: this.#state, event, to, at: this.clock() });
    this.#state = to;
    return to;
  }

  snapshot(): MachineSnapshot {
    return { state: this.#state, history: [...this.#history] };
  }
}

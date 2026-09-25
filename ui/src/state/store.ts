/**
 * 全局状态（zustand）：事件增量缓冲 + seq 游标、侧栏状态、模型、运行状态、对话。
 * 事件按 seq 排序去重，保证 SSE 断线 since 补发后不丢不乱序。
 */
import { create } from "zustand";
import type { ChatAction, ConnectionState, ModelInfo, RunStatus } from "../api/client";
import type { UIEventEnvelope } from "../protocols/ui-events";

/** 侧栏展开/收起与宽度的持久化 key（验收 #1）。 */
const SIDEBAR_STORAGE_KEY = "dual-agent.sidebar";

export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 340;

export interface SidebarPrefs {
  open: boolean;
  width: number;
}

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  /** 用户消息带“介入”徽标（区别自动流程消息）。 */
  intervention: boolean;
  /** 编排器介入策略（POST /api/chat 响应 action）。 */
  action?: ChatAction;
  source: "sse" | "local";
  /** 本地乐观条目被 SSE chat.message 对齐后置 true，避免重复展示。 */
  claimed: boolean;
}

export interface ChatEntryInput {
  role: "user" | "assistant";
  content: string;
  source: "sse" | "local";
  intervention?: boolean;
  action?: ChatAction;
  at?: string;
}

export interface DualAgentState {
  runId: string;
  requirement: string;
  runSummary: string;
  finalStatus: string | null;
  /** 事件增量缓冲（按 seq 升序、去重）。 */
  events: UIEventEnvelope[];
  /** seq 游标：已消费的最大序号（重连 since 补发用）。 */
  lastSeq: number;
  sidebar: SidebarPrefs;
  /** 侧栏收起期间的新事件计数（开关角标）。 */
  unread: number;
  models: ModelInfo[];
  modelsError: string | null;
  status: RunStatus | null;
  statusError: string | null;
  chat: ChatEntry[];
  connection: ConnectionState;
  notice: string | null;
  /** 递增触发 PlannerChat 输入框聚焦（Ctrl+K）。 */
  chatFocusTick: number;

  ingest: (envelopes: UIEventEnvelope[]) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setModels: (models: ModelInfo[], error: string | null) => void;
  setStatus: (status: RunStatus | null, error: string | null) => void;
  setConnection: (connection: ConnectionState) => void;
  setNotice: (notice: string | null) => void;
  appendChat: (input: ChatEntryInput) => void;
  requestChatFocus: () => void;
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function loadSidebarPrefs(): SidebarPrefs {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SidebarPrefs> | null;
      if (parsed && typeof parsed === "object") {
        return {
          open: typeof parsed.open === "boolean" ? parsed.open : true,
          width: clampWidth(typeof parsed.width === "number" ? parsed.width : DEFAULT_SIDEBAR_WIDTH),
        };
      }
    }
  } catch {
    // localStorage 不可用或数据损坏时使用默认值
  }
  return { open: true, width: DEFAULT_SIDEBAR_WIDTH };
}

function saveSidebarPrefs(prefs: SidebarPrefs): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略持久化失败
  }
}

function initialRunId(): string {
  try {
    return new URLSearchParams(window.location.search).get("runId") ?? "";
  } catch {
    return "";
  }
}

let chatLocalSeq = 0;

export const useDualAgentStore = create<DualAgentState>((set) => ({
  runId: initialRunId(),
  requirement: "",
  runSummary: "",
  finalStatus: null,
  events: [],
  lastSeq: 0,
  sidebar: loadSidebarPrefs(),
  unread: 0,
  models: [],
  modelsError: null,
  status: null,
  statusError: null,
  chat: [],
  connection: "connecting",
  notice: null,
  chatFocusTick: 0,

  ingest: (envelopes) => {
    set((state) => {
      if (envelopes.length === 0) return {};
      const merged = new Map<number, UIEventEnvelope>();
      for (const env of state.events) merged.set(env.seq, env);
      const fresh: UIEventEnvelope[] = [];
      for (const env of envelopes) {
        if (!Number.isFinite(env.seq) || merged.has(env.seq)) continue;
        merged.set(env.seq, env);
        fresh.push(env);
      }
      if (fresh.length === 0) return {};

      // 按 seq 排序去重后的事件缓冲
      const events = Array.from(merged.values()).sort((a, b) => a.seq - b.seq);
      const lastSeq = Math.max(state.lastSeq, events[events.length - 1]?.seq ?? 0);

      let runId = state.runId;
      let requirement = state.requirement;
      let runSummary = state.runSummary;
      let finalStatus = state.finalStatus;
      let chat = state.chat;
      let status = state.status;
      let notice = state.notice;

      for (const env of [...fresh].sort((a, b) => a.seq - b.seq)) {
        const ev = env.event;
        switch (ev.type) {
          case "run.started":
            if (!runId) runId = env.runId;
            if (ev.requirement.length > 0) requirement = ev.requirement;
            break;
          case "run.finished":
            finalStatus = ev.status;
            runSummary = ev.summary ?? "";
            if (status) status = { ...status, running: false };
            break;
          case "stage.changed":
            if (status) status = { ...status, stage: ev.stage };
            break;
          case "chat.message": {
            const index = chat.findIndex(
              (c) => c.source === "local" && !c.claimed && c.role === ev.role && c.content === ev.content,
            );
            if (index >= 0) {
              const next = chat.slice();
              next[index] = { ...next[index], claimed: true };
              chat = next;
            } else {
              chat = [
                ...chat,
                {
                  id: `evt-${env.seq}`,
                  role: ev.role,
                  content: ev.content,
                  at: env.at,
                  intervention: ev.role === "user",
                  source: "sse",
                  claimed: false,
                },
              ];
            }
            break;
          }
          case "model.changed": {
            if (status) {
              const models = { ...status.models };
              if (ev.channel === "planner") models.planner = ev.model;
              else models.coder = ev.model;
              status = { ...status, models };
            }
            break;
          }
          case "workflow.paused":
            if (status) status = { ...status, paused: true };
            notice = ev.reason.length > 0 ? `已暂停：${ev.reason}` : "已暂停";
            break;
          case "workflow.resumed":
            if (status) status = { ...status, paused: false };
            notice = ev.reason.length > 0 ? `已恢复：${ev.reason}` : "已恢复";
            break;
          default:
            break;
        }
      }

      const unread = state.sidebar.open ? 0 : state.unread + fresh.length;
      return { events, lastSeq, runId, requirement, runSummary, finalStatus, chat, status, notice, unread };
    });
  },

  setSidebarOpen: (open) =>
    set((state) => {
      const sidebar = { ...state.sidebar, open };
      saveSidebarPrefs(sidebar);
      return { sidebar, unread: open ? 0 : state.unread };
    }),

  toggleSidebar: () =>
    set((state) => {
      const open = !state.sidebar.open;
      const sidebar = { ...state.sidebar, open };
      saveSidebarPrefs(sidebar);
      return { sidebar, unread: open ? 0 : state.unread };
    }),

  setSidebarWidth: (width) =>
    set((state) => {
      const sidebar = { ...state.sidebar, width: clampWidth(width) };
      saveSidebarPrefs(sidebar);
      return { sidebar };
    }),

  setModels: (models, error) => set({ models, modelsError: error }),

  setStatus: (status, error) => set({ status, statusError: error }),

  setConnection: (connection) => set({ connection }),

  setNotice: (notice) => set({ notice }),

  appendChat: (input) =>
    set((state) => ({
      chat: [
        ...state.chat,
        {
          id: `local-${Date.now()}-${(chatLocalSeq += 1)}`,
          role: input.role,
          content: input.content,
          at: input.at ?? new Date().toISOString(),
          intervention: input.intervention ?? input.role === "user",
          action: input.action,
          source: input.source,
          claimed: false,
        },
      ],
    })),

  requestChatFocus: () => set((state) => ({ chatFocusTick: state.chatFocusTick + 1 })),
}));

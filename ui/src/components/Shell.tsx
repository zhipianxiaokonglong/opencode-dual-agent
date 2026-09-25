/**
 * 应用外壳（契约 §3 视觉要求 1/3/8）：
 * - 双栏布局：工具栏 + 可收起侧栏 + 主栏（只读开发过程视图）
 * - 侧栏宽度 280–480px 可拖拽，展开/收起 ≤200ms 过渡，状态持久化 localStorage
 * - SSE 订阅（断线重连 since 补发）+ REST 初始化
 * - 快捷键：Esc 收起侧栏、Ctrl+K 聚焦对话框
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getStatus, listModels, subscribeEvents } from "../api/client";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useDualAgentStore } from "../state/store";
import Toolbar from "./Toolbar";
import StageTimeline from "./Sidebar/StageTimeline";
import ProcessStream from "./Sidebar/ProcessStream";
import PlannerChat from "./Sidebar/PlannerChat";
import ModelPicker from "./Sidebar/ModelPicker";
import CoderSession from "./Main/CoderSession";

export default function Shell() {
  const sidebar = useDualAgentStore((s) => s.sidebar);
  const setSidebarWidth = useDualAgentStore((s) => s.setSidebarWidth);
  const runId = useDualAgentStore((s) => s.runId);
  const [dragging, setDragging] = useState(false);

  // REST 初始化 + 状态轮询（保持状态徽标与运行开关同步）
  useEffect(() => {
    async function refreshAll(): Promise<void> {
      const state = useDualAgentStore.getState();
      try {
        state.setStatus(await getStatus(state.runId), null);
      } catch (e) {
        state.setStatus(state.status, e instanceof Error ? e.message : String(e));
      }
      try {
        state.setModels(await listModels(), null);
      } catch (e) {
        state.setModels([], e instanceof Error ? e.message : String(e));
      }
    }
    void refreshAll();
    const timer = window.setInterval(() => {
      const state = useDualAgentStore.getState();
      getStatus(state.runId)
        .then((status) => state.setStatus(status, null))
        .catch(() => {
          // 静默失败：保留已有状态，连接状态由 SSE 指示
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  // SSE 订阅：runId 变化时重建连接，since 从当前 seq 游标续传（不丢不乱序由 store 保证）
  useEffect(() => {
    const unsubscribe = subscribeEvents({
      runId,
      since: useDualAgentStore.getState().lastSeq,
      onEnvelope: (envelope) => useDualAgentStore.getState().ingest([envelope]),
      onConnection: (connection) => useDualAgentStore.getState().setConnection(connection),
    });
    return unsubscribe;
  }, [runId]);

  // 快捷键：Esc 收起侧栏 / Ctrl+K 聚焦对话框
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        const state = useDualAgentStore.getState();
        if (state.sidebar.open) state.setSidebarOpen(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        useDualAgentStore.getState().requestChatFocus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function onResizeStart(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebar.width;
    setDragging(true);
    const onMove = (ev: PointerEvent): void => setSidebarWidth(startWidth + (ev.clientX - startX));
    const onUp = (): void => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className={`shell ${dragging ? "shell--dragging" : ""}`}>
      <Toolbar />
      <div className="shell-body">
        <aside
          id="dual-sidebar"
          className="sidebar"
          aria-label="过程侧栏"
          aria-hidden={!sidebar.open}
          style={{ width: sidebar.open ? sidebar.width : 0 }}
        >
          <div className="sidebar-inner" style={{ width: sidebar.width }}>
            <ModelPicker channel="planner" title="思考模型" />
            <StageTimeline />
            <ProcessStream />
            <PlannerChat />
          </div>
        </aside>

        {sidebar.open && (
          <div
            className="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整侧栏宽度"
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebar.width}
            onPointerDown={onResizeStart}
          />
        )}

        <main className="main" id="dual-main">
          <CoderSession />
        </main>
      </div>
    </div>
  );
}

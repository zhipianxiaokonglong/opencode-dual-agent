/**
 * 工具栏（契约 §3 视觉要求 1）：
 * [≡ 侧栏开关] 任务标题 状态徽标 [⏸][⏹][导出]
 * - [⏸]/[▶] 按运行状态调用 POST /api/pause 与 POST /api/resume
 * - [⏹] 停止：契约暂无停止接口，占位 disabled + tooltip“后续版本”
 * - [导出] GET /api/export → 下载 markdown 文件
 * - 侧栏收起期间的新事件角标计数
 */
import { useState } from "react";
import { exportRun, pauseRun, resumeRun } from "../api/client";
import { useDualAgentStore } from "../state/store";

function shortTitle(requirement: string): string {
  const firstLine = requirement.split("\n").find((line) => line.trim().length > 0) ?? "";
  const text = firstLine.trim();
  if (text.length === 0) return "未开始任务";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export default function Toolbar() {
  const sidebar = useDualAgentStore((s) => s.sidebar);
  const unread = useDualAgentStore((s) => s.unread);
  const toggleSidebar = useDualAgentStore((s) => s.toggleSidebar);
  const requirement = useDualAgentStore((s) => s.requirement);
  const status = useDualAgentStore((s) => s.status);
  const finalStatus = useDualAgentStore((s) => s.finalStatus);
  const connection = useDualAgentStore((s) => s.connection);
  const notice = useDualAgentStore((s) => s.notice);
  const runId = useDualAgentStore((s) => s.runId);
  const setStatus = useDualAgentStore((s) => s.setStatus);
  const setNotice = useDualAgentStore((s) => s.setNotice);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paused = status?.paused === true;
  const badgeClass = finalStatus
    ? finalStatus === "completed" || finalStatus === "success"
      ? "badge badge--done"
      : "badge badge--fail"
    : paused
      ? "badge badge--pause"
      : status?.running
        ? "badge badge--run"
        : "badge badge--idle";
  const badgeText = finalStatus
    ? `已结束 · ${finalStatus}`
    : paused
      ? "已暂停"
      : status?.running
        ? `运行中 · 第 ${status.round} 轮`
        : "空闲";

  async function handlePauseToggle() {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      if (paused) {
        await resumeRun(runId);
        setStatus({ ...status, paused: false }, null);
        setNotice("已恢复运行");
      } else {
        await pauseRun(runId, "用户暂停");
        setStatus({ ...status, paused: true }, null);
        setNotice("已暂停（用户请求）");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const { markdown } = await exportRun(runId);
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dual-agent-${runId || "run"}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <button
          type="button"
          className="btn btn-icon"
          id="sidebar-toggle"
          aria-label={sidebar.open ? "收起侧栏" : "展开侧栏"}
          aria-expanded={sidebar.open}
          aria-controls="dual-sidebar"
          onClick={toggleSidebar}
        >
          <span aria-hidden="true">≡</span>
          {!sidebar.open && unread > 0 && <span className="badge-count">{unread > 99 ? "99+" : unread}</span>}
        </button>
        <h1 className="toolbar-title" title={requirement || undefined}>
          {shortTitle(requirement)}
        </h1>
        <span className={badgeClass} role="status">{badgeText}</span>
        {notice && <span className="toolbar-notice">{notice}</span>}
      </div>

      <div className="toolbar-right">
        <span className={`conn-dot conn-dot--${connection}`} aria-label={`事件流连接状态：${connection}`}>
          {connection === "open" ? "实时" : connection === "reconnecting" ? "重连中" : "连接中"}
        </span>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={paused ? "继续任务（POST /api/resume）" : "暂停任务（POST /api/pause）"}
          title={paused ? "继续" : "暂停"}
          disabled={busy || !status}
          onClick={() => void handlePauseToggle()}
        >
          <span aria-hidden="true">{paused ? "▶" : "⏸"}</span>
        </button>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="停止任务（后续版本）"
          title="后续版本"
          disabled
        >
          <span aria-hidden="true">⏹</span>
        </button>
        <button
          type="button"
          className="btn"
          aria-label="导出过程记录（markdown）"
          title="导出过程记录"
          disabled={busy}
          onClick={() => void handleExport()}
        >
          导出
        </button>
      </div>

      {error && <p className="toolbar-error" role="alert">{error}</p>}
    </header>
  );
}

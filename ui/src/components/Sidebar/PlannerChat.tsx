/**
 * 思考模型对话（契约 §3 视觉要求 5）：
 * - 用户消息带“介入”徽标，区别自动流程消息
 * - workflow.paused 时输入框提示“已暂停，回复将进入咨询”，并可点“继续”（POST /api/resume）
 * - POST /api/chat 进入编排器介入策略，展示 action 徽标
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getStatus, postChat, resumeRun } from "../../api/client";
import { useDualAgentStore } from "../../state/store";
import RedactedText from "../RedactedText";
import { CHAT_ACTION_LABELS, formatTime } from "../labels";

export default function PlannerChat() {
  const chat = useDualAgentStore((s) => s.chat);
  const runId = useDualAgentStore((s) => s.runId);
  const status = useDualAgentStore((s) => s.status);
  const chatFocusTick = useDualAgentStore((s) => s.chatFocusTick);
  const appendChat = useDualAgentStore((s) => s.appendChat);
  const setStatus = useDualAgentStore((s) => s.setStatus);
  const setNotice = useDualAgentStore((s) => s.setNotice);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const paused = status?.paused === true;

  // Ctrl+K 聚焦到对话框
  useEffect(() => {
    if (chatFocusTick > 0) inputRef.current?.focus();
  }, [chatFocusTick]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  async function handleSend() {
    const message = draft.trim();
    if (message.length === 0 || sending) return;
    setDraft("");
    setError(null);
    setSending(true);
    appendChat({ role: "user", content: message, source: "local", intervention: true });
    try {
      const reply = await postChat(runId, message);
      appendChat({ role: "assistant", content: reply.reply, source: "local", action: reply.action });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  }

  async function handleResume() {
    setError(null);
    try {
      await resumeRun(runId);
      const next = await getStatus(runId);
      setStatus(next, null);
      setNotice("已恢复运行");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="sidebar-section chat">
      <h2 className="section-title">
        对话介入
        <span className="section-hint">Ctrl+K 聚焦</span>
      </h2>
      <div className="chat-list" ref={listRef} role="log" aria-label="思考模型对话">
        {chat.length === 0 && <p className="empty-state">还没有对话，发送消息即可介入任务。</p>}
        {chat.map((entry) => (
          <article key={entry.id} className={`bubble ${entry.role === "user" ? "bubble--user" : "bubble--assistant"}`}>
            <header className="bubble-meta">
              <span className="bubble-role">{entry.role === "user" ? "我" : "思考模型"}</span>
              {entry.intervention && <span className="intervene-badge">介入</span>}
              {entry.action && <span className="action-badge">{CHAT_ACTION_LABELS[entry.action]}</span>}
              <time className="bubble-time" dateTime={entry.at}>{formatTime(entry.at)}</time>
            </header>
            <div className="bubble-body">
              <RedactedText text={entry.content} />
            </div>
          </article>
        ))}
      </div>

      <div className="chat-form">
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={2}
          value={draft}
          placeholder={paused ? "已暂停，回复将进入咨询" : "输入消息介入任务…（Enter 发送，Shift+Enter 换行）"}
          aria-label="对话输入框"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-actions">
          <button
            type="button"
            className="btn btn-primary"
            aria-label="发送对话消息"
            disabled={sending || draft.trim().length === 0}
            onClick={() => void handleSend()}
          >
            发送
          </button>
          {paused && (
            <button type="button" className="btn" aria-label="继续运行（POST /api/resume）" onClick={() => void handleResume()}>
              继续
            </button>
          )}
        </div>
      </div>
      {paused && <p className="chat-paused-hint">已暂停，回复将进入咨询</p>}
      {error && <p className="picker-error">{error}</p>}
    </section>
  );
}

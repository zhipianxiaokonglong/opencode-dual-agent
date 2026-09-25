/**
 * 过程流（契约 §3 视觉要求 2）：卡片带阶段标签 / 时间戳 / 模型名 / 可折叠详情。
 * 汇集编排过程事件（run.*、planner.output、model.changed、workflow.*）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Stage, UIEventEnvelope } from "../../protocols/ui-events";
import { useDualAgentStore } from "../../state/store";
import RedactedText from "../RedactedText";
import { PLANNER_KIND_LABELS, formatTime, modelLabel, stageLabel } from "../labels";

type FlowKind = "run" | "planner" | "model" | "workflow" | "finished";

interface FlowItem {
  seq: number;
  at: string;
  stage: Stage | null;
  model: string;
  kind: FlowKind;
  kindLabel: string;
  content: string;
  detail: string | null;
}

function buildItems(events: UIEventEnvelope[]): FlowItem[] {
  const items: FlowItem[] = [];
  let stage: Stage | null = null;
  let plannerModel: string = "—";

  for (const env of events) {
    const ev = env.event;
    if (ev.type === "stage.changed") stage = ev.stage;
    if (ev.type === "model.changed" && ev.channel === "planner") plannerModel = modelLabel(ev.model);

    switch (ev.type) {
      case "run.started":
        items.push({
          seq: env.seq,
          at: env.at,
          stage,
          model: plannerModel,
          kind: "run",
          kindLabel: "任务开始",
          content: ev.requirement,
          detail: null,
        });
        break;
      case "planner.output":
        items.push({
          seq: env.seq,
          at: env.at,
          stage,
          model: plannerModel,
          kind: "planner",
          kindLabel: PLANNER_KIND_LABELS[ev.kind] ?? ev.kind,
          content: ev.content,
          detail: ev.payload === undefined ? null : JSON.stringify(ev.payload, null, 2),
        });
        break;
      case "model.changed":
        items.push({
          seq: env.seq,
          at: env.at,
          stage,
          model: modelLabel(ev.model),
          kind: "model",
          kindLabel: "模型切换",
          content: `${ev.channel === "planner" ? "思考模型" : "开发模型"}切换为 ${modelLabel(ev.model)}`,
          detail: JSON.stringify(ev.model, null, 2),
        });
        break;
      case "workflow.paused":
      case "workflow.resumed":
        items.push({
          seq: env.seq,
          at: env.at,
          stage,
          model: plannerModel,
          kind: "workflow",
          kindLabel: ev.type === "workflow.paused" ? "工作流暂停" : "工作流恢复",
          content: ev.reason.length > 0 ? ev.reason : ev.type === "workflow.paused" ? "已暂停" : "已恢复",
          detail: null,
        });
        break;
      case "run.finished":
        items.push({
          seq: env.seq,
          at: env.at,
          stage,
          model: plannerModel,
          kind: "finished",
          kindLabel: "任务结束",
          content: ev.summary.length > 0 ? `${ev.status} — ${ev.summary}` : ev.status,
          detail: null,
        });
        break;
      default:
        break;
    }
  }
  return items;
}

function CollapsibleDetails({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card-details">
      <button
        type="button"
        className="link-btn"
        aria-expanded={open}
        aria-label={open ? "收起详情" : "展开详情"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起详情 ▲" : "展开详情 ▼"}
      </button>
      {open && <pre className="details-pre">{text}</pre>}
    </div>
  );
}

export default function ProcessStream() {
  const events = useDualAgentStore((s) => s.events);
  const items = useMemo(() => buildItems(events), [events]);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  return (
    <section className="sidebar-section sidebar-section--stream">
      <h2 className="section-title">过程流</h2>
      <div className="stream" ref={listRef} onScroll={onScroll} role="log" aria-label="编排过程流">
        {items.length === 0 && <p className="empty-state">等待过程事件…</p>}
        {items.map((item) => (
          <article key={item.seq} className={`card card--${item.kind}`}>
            <header className="card-header">
              <span className="stage-tag">{stageLabel(item.stage)}</span>
              <span className="kind-tag">{item.kindLabel}</span>
              <time className="card-time" dateTime={item.at}>{formatTime(item.at)}</time>
              <span className="card-model">{item.model}</span>
            </header>
            <div className="card-body">
              <RedactedText text={item.content} />
            </div>
            {item.detail !== null && <CollapsibleDetails text={item.detail} />}
          </article>
        ))}
      </div>
    </section>
  );
}

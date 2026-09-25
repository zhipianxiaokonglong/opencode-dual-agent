/**
 * 阶段时间线（契约 §3 视觉要求 1/2）：● 完成 / ◐ 当前 / ○ 未达。
 * 由 stage.changed 事件推导实际路径，尾部补主线阶段作为“未达”。
 */
import { useMemo } from "react";
import type { Stage } from "../../protocols/ui-events";
import { useDualAgentStore } from "../../state/store";
import { MAIN_FLOW_STAGES, formatTime, stageLabel } from "../labels";

type Marker = "done" | "current" | "pending";

interface TimelineItem {
  stage: Stage;
  at: string;
  note: string;
  marker: Marker;
}

const TERMINAL: ReadonlySet<Stage> = new Set<Stage>(["COMPLETED", "STOPPED", "CANCELLED", "FAILED"]);
const MARKER_GLYPH: Record<Marker, string> = { done: "●", current: "◐", pending: "○" };
const MARKER_TEXT: Record<Marker, string> = { done: "完成", current: "当前", pending: "未达" };

export default function StageTimeline() {
  const events = useDualAgentStore((s) => s.events);
  const status = useDualAgentStore((s) => s.status);

  const items = useMemo<TimelineItem[]>(() => {
    const observed: Array<{ stage: Stage; at: string; note: string }> = [];
    for (const env of events) {
      if (env.event.type !== "stage.changed") continue;
      const entry = { stage: env.event.stage, at: env.event.at || env.at, note: env.event.note ?? "" };
      const prev = observed[observed.length - 1];
      if (prev && prev.stage === entry.stage) continue; // 连续同阶段去重
      observed.push(entry);
    }

    const currentStage = status?.stage ?? (observed.length > 0 ? observed[observed.length - 1].stage : null);
    const result: TimelineItem[] = [];
    observed.forEach((entry, index) => {
      const isLast = index === observed.length - 1;
      const terminal = TERMINAL.has(entry.stage);
      result.push({ ...entry, marker: isLast && !terminal && entry.stage === currentStage ? "current" : "done" });
    });

    if (observed.length === 0 && currentStage !== null) {
      result.push({ stage: currentStage, at: "", note: "", marker: TERMINAL.has(currentStage) ? "done" : "current" });
    }

    const seen = new Set<Stage>(observed.map((entry) => entry.stage));
    if (currentStage !== null) seen.add(currentStage);
    for (const stage of MAIN_FLOW_STAGES) {
      if (seen.has(stage)) continue;
      result.push({ stage, at: "", note: "", marker: "pending" });
    }
    return result;
  }, [events, status]);

  return (
    <section className="sidebar-section">
      <h2 className="section-title">阶段时间线</h2>
      <ol className="timeline">
        {items.map((item, index) => (
          <li key={`${item.stage}-${index}`} className={`tl-item tl-item--${item.marker}`} title={item.note || undefined}>
            <span className="tl-marker" aria-hidden="true">{MARKER_GLYPH[item.marker]}</span>
            <span className="tl-label">{stageLabel(item.stage)}</span>
            <span className="sr-only">（{MARKER_TEXT[item.marker]}）</span>
            <span className="tl-time">{item.at ? formatTime(item.at) : ""}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

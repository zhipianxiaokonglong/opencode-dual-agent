/**
 * 主栏 · 开发模型会话（契约 §3 视觉要求 6）：只读过程视图。
 * - coder.progress 逐行渲染（读取文件 / 修改摘要 / 测试执行），按任务分组（task-001 …）
 * - 顶部开发模型选择器；任务级操作按钮占位（disabled + tooltip“后续版本”）
 * - test.report → 测试结果摘要卡片
 */
import { useMemo } from "react";
import type { CoderAction, TestReport, UIEventEnvelope } from "../../protocols/ui-events";
import { useDualAgentStore } from "../../state/store";
import ModelPicker from "../Sidebar/ModelPicker";
import RedactedText from "../RedactedText";
import { CODER_ACTION_LABELS, formatTime, modelLabel } from "../labels";

interface ProgressLine {
  seq: number;
  action: CoderAction;
  content: string;
  at: string;
}

interface TaskGroup {
  taskId: string;
  model: string;
  lines: ProgressLine[];
}

interface TestCard {
  seq: number;
  at: string;
  report: TestReport;
}

const TEST_STATUS_LABELS: Record<TestReport["status"], string> = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  error: "错误",
  not_run: "未执行",
};

function buildView(events: UIEventEnvelope[]): { tasks: TaskGroup[]; tests: TestCard[] } {
  const order: string[] = [];
  const groups = new Map<string, TaskGroup>();
  const tests: TestCard[] = [];
  let coderModel = "—";

  for (const env of events) {
    const ev = env.event;
    if (ev.type === "model.changed" && ev.channel === "coder") coderModel = modelLabel(ev.model);
    if (ev.type === "coder.progress") {
      let group = groups.get(ev.taskId);
      if (!group) {
        group = { taskId: ev.taskId, model: coderModel, lines: [] };
        groups.set(ev.taskId, group);
        order.push(ev.taskId);
      }
      group.lines.push({ seq: env.seq, action: ev.action, content: ev.content, at: env.at });
    } else if (ev.type === "test.report") {
      tests.push({ seq: env.seq, at: env.at, report: ev.report });
    }
  }
  return { tasks: order.map((taskId) => groups.get(taskId) as TaskGroup), tests };
}

export default function CoderSession() {
  const events = useDualAgentStore((s) => s.events);
  const requirement = useDualAgentStore((s) => s.requirement);
  const runSummary = useDualAgentStore((s) => s.runSummary);
  const { tasks, tests } = useMemo(() => buildView(events), [events]);

  return (
    <div className="coder-session">
      <header className="main-header">
        <ModelPicker channel="coder" title="开发模型" />
        <span className="readonly-chip" title="主栏为只读过程视图">只读过程视图</span>
      </header>

      {requirement.length > 0 && (
        <section className="requirement-card">
          <h2 className="section-title">任务需求</h2>
          <div className="requirement-body">
            <RedactedText text={requirement} />
          </div>
        </section>
      )}

      <section className="main-section">
        <h2 className="section-title">开发过程（{tasks.length} 个任务）</h2>
        {tasks.length === 0 && <p className="empty-state">等待开发模型输出…</p>}
        {tasks.map((task) => (
          <article key={task.taskId} className="task-group">
            <header className="task-head">
              <span className="task-id">{task.taskId}</span>
              <span className="task-model">{task.model}</span>
              <div className="task-actions">
                <button type="button" className="btn btn-sm" disabled title="后续版本" aria-label="重试任务（后续版本）">重试</button>
                <button type="button" className="btn btn-sm" disabled title="后续版本" aria-label="跳过任务（后续版本）">跳过</button>
                <button type="button" className="btn btn-sm" disabled title="后续版本" aria-label="查看差异（后续版本）">查看差异</button>
              </div>
            </header>
            <ol className="progress-list">
              {task.lines.map((line) => (
                <li key={line.seq} className="progress-line">
                  <span className={`action-tag action-tag--${line.action}`}>{CODER_ACTION_LABELS[line.action]}</span>
                  <span className="progress-content">
                    <RedactedText text={line.content} />
                  </span>
                  <time className="line-time" dateTime={line.at}>{formatTime(line.at)}</time>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </section>

      {tests.length > 0 && (
        <section className="main-section">
          <h2 className="section-title">测试结果摘要</h2>
          {tests.map(({ seq, at, report }) => (
            <article key={seq} className="test-card">
              <header className="card-header">
                <span className={`test-status test-status--${report.status}`}>{TEST_STATUS_LABELS[report.status]}</span>
                <span className="kind-tag">{report.checkId}</span>
                <time className="card-time" dateTime={at}>{formatTime(at)}</time>
                <span className="card-model">{report.profile}</span>
              </header>
              <ul className="test-meta">
                <li>revision：<code>{report.revision}</code></li>
                <li>退出码：{report.exitCode ?? "—"}</li>
                <li>耗时：{report.durationMs}ms</li>
                {report.logArtifact && <li>日志：<code>{report.logArtifact}</code></li>}
              </ul>
              {report.failedTests.length > 0 && (
                <ul className="failed-tests">
                  {report.failedTests.map((failed) => (
                    <li key={failed.name}>
                      <strong>{failed.name}</strong>
                      {failed.summary.length > 0 && (
                        <span className="failed-summary">
                          <RedactedText text={failed.summary} />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}

      {runSummary.length > 0 && (
        <section className="main-section">
          <h2 className="section-title">任务总结</h2>
          <div className="card">
            <div className="card-body">
              <RedactedText text={runSummary} />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

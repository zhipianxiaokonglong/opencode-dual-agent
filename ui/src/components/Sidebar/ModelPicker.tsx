/**
 * 双模型选择器（契约 §3 视觉要求 4）：
 * - 下拉展示 GET /api/models 的模型；不可用模型灰置 + 原因
 * - 运行中切换弹二次确认（“当前阶段结束后生效”）
 * - 三级优先级 scope：本次任务 / 本项目 / 全局
 */
import { useEffect, useRef, useState } from "react";
import { postModel, type Channel, type ModelInfo, type ModelScope } from "../../api/client";
import { useDualAgentStore } from "../../state/store";
import { modelLabel } from "../labels";

const SCOPE_OPTIONS: ReadonlyArray<{ value: ModelScope; label: string }> = [
  { value: "task", label: "本次任务" },
  { value: "project", label: "本项目" },
  { value: "global", label: "全局" },
];

interface Props {
  /** planner=侧栏思考模型，coder=主栏开发模型 */
  channel: Channel;
  title: string;
}

/** 不可用原因（灰置展示），无理由返回 null。 */
function unavailability(model: ModelInfo, channel: Channel): string | null {
  if (model.available === false) return model.unavailableReason ?? model.reason ?? "该模型当前不可用";
  if (channel === "coder" && model.tools === false) return "不支持工具调用（开发模型需要）";
  return null;
}

export default function ModelPicker({ channel, title }: Props) {
  const models = useDualAgentStore((s) => s.models);
  const modelsError = useDualAgentStore((s) => s.modelsError);
  const status = useDualAgentStore((s) => s.status);
  const setStatus = useDualAgentStore((s) => s.setStatus);

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ModelScope>("task");
  const [confirmTarget, setConfirmTarget] = useState<ModelInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = channel === "planner" ? status?.models.planner ?? null : status?.models.coder ?? null;
  const currentLabel = modelLabel(current);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 二次确认弹窗：Esc 取消（capture 阻断全局 Esc 收起侧栏）
  useEffect(() => {
    if (confirmTarget === undefined) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setConfirmTarget(undefined);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirmTarget]);

  async function apply(target: ModelInfo | null) {
    const modelRef = target ? { providerID: target.providerID, id: target.id } : null;
    setError(null);
    setOpen(false);
    try {
      const result = await postModel(channel, modelRef, scope);
      if (status) {
        const nextModels = { ...status.models };
        if (channel === "planner") nextModels.planner = result.model ?? modelRef;
        else nextModels.coder = result.model ?? modelRef;
        setStatus({ ...status, models: nextModels }, null);
      }
      setHint(result.effectiveFrom === "next-stage" ? "当前阶段结束后生效" : `生效时机：${result.effectiveFrom}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function choose(target: ModelInfo | null) {
    const same = target === null ? current === null : current !== null && current.providerID === target.providerID && current.id === target.id;
    if (same) {
      setOpen(false);
      return;
    }
    if (status?.running) {
      setConfirmTarget(target); // 运行中切换 → 二次确认
    } else {
      void apply(target);
    }
  }

  const confirmModel = confirmTarget === undefined ? undefined : confirmTarget;

  return (
    <div className="picker" ref={rootRef}>
      <div className="picker-row">
        <span className="picker-title">{title}</span>
        <button
          type="button"
          className="picker-button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${title}：${currentLabel}，点击切换模型`}
          onClick={() => setOpen((v) => !v)}
        >
          {currentLabel}
          <span className="picker-caret" aria-hidden="true">▾</span>
        </button>
      </div>

      {open && (
        <div className="picker-menu" role="listbox" aria-label={`${title}候选模型`}>
          <button
            type="button"
            role="option"
            aria-selected={current === null}
            className={`picker-item ${current === null ? "selected" : ""}`}
            onClick={() => choose(null)}
          >
            <span className="picker-item-name">自动选择</span>
            <span className="picker-item-meta">由编排器决定</span>
          </button>
          {models.length === 0 && (
            <div className="picker-empty">{modelsError ?? "暂无可用模型（GET /api/models 为空）"}</div>
          )}
          {models.map((model) => {
            const reason = unavailability(model, channel);
            const selected = current !== null && current.providerID === model.providerID && current.id === model.id;
            return (
              <button
                key={`${model.providerID}/${model.id}`}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={reason !== null}
                title={reason ?? undefined}
                className={`picker-item ${selected ? "selected" : ""} ${reason !== null ? "disabled" : ""}`}
                onClick={() => choose(model)}
              >
                <span className="picker-item-name">{modelLabel(model)}</span>
                <span className="picker-item-meta">
                  {model.contextLength ? `${Math.round(model.contextLength / 1000)}k ctx` : ""}
                  {model.tools === false ? " · 无工具" : ""}
                </span>
                {reason !== null && <span className="picker-item-reason">{reason}</span>}
              </button>
            );
          })}
          <div className="picker-scope" role="radiogroup" aria-label="生效范围（三级优先级）">
            {SCOPE_OPTIONS.map((option) => (
              <label key={option.value} className={`picker-scope-item ${scope === option.value ? "selected" : ""}`}>
                <input
                  type="radio"
                  name={`model-scope-${channel}`}
                  value={option.value}
                  checked={scope === option.value}
                  onChange={() => setScope(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {confirmModel !== undefined && (
        <div className="modal-overlay" role="presentation" onMouseDown={() => setConfirmTarget(undefined)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="确认切换模型"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="modal-title">确认切换模型？</h3>
            <p className="modal-text">
              当前阶段结束后生效。即将把「{title}」切换为「
              {confirmModel === null ? "自动选择" : modelLabel(confirmModel)}」。
            </p>
            <div className="modal-actions">
              <button type="button" className="btn" aria-label="取消切换模型" onClick={() => setConfirmTarget(undefined)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                aria-label="确认切换模型"
                onClick={() => {
                  const target = confirmModel;
                  setConfirmTarget(undefined);
                  void apply(target);
                }}
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      )}

      {hint && <p className="picker-hint">{hint}</p>}
      {error && <p className="picker-error">{error}</p>}
    </div>
  );
}

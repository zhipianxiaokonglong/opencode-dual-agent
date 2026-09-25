/**
 * 插件 RPC（v1.1 §4.2 / P0 报告 §3）：UI ↔ 编排器的唯一通道。
 * 外部客户端（自建 UI / TUI 插件）经 @opencode/client 的 client.rpc(DualAgent) 调用。
 *
 * 事件订阅是"仅实时"的（官方限制），断线补发走 events 方法（按 seq），
 * 由 EventBus 的持久化序号保证不丢不乱序。
 * Schema 使用 zod（Standard Schema 兼容）。
 */
import { z } from "zod";
import { Rpc } from "@opencode/plugin/rpc";

const ModelRefZ = z
  .object({ providerID: z.string(), id: z.string() })
  .strict();

const EnvelopeZ = z
  .object({
    seq: z.number().int(),
    runId: z.string(),
    at: z.string(),
    event: z.record(z.unknown()),
  })
  .passthrough();

const EventsInput = z.object({ runId: z.string(), since: z.number().int() }).strict();
const EventsOutput = z
  .object({
    events: z.array(EnvelopeZ),
    latest: z.number().int(),
  })
  .strict();
const RunNotFound = z.object({ runId: z.string() }).strict();

const StatusInput = z.object({ runId: z.string() }).strict();
const StatusOutput = z
  .object({
    runId: z.string(),
    state: z.string(),
    stage: z.string(),
    round: z.number().int(),
    running: z.boolean(),
    paused: z.boolean(),
    models: z.record(z.union([ModelRefZ, z.null()])),
  })
  .strict();

const ChatInput = z.object({ runId: z.string(), message: z.string() }).strict();
const ChatOutput = z.object({ reply: z.string(), action: z.string() }).strict();

const ModelSetInput = z
  .object({
    runId: z.string(),
    channel: z.enum(["planner", "coder"]),
    model: ModelRefZ.nullable(),
    scope: z.enum(["task", "project", "global"]),
  })
  .strict();
const ModelSetOutput = z
  .object({
    model: ModelRefZ.nullable(),
    effectiveFrom: z.string(),
  })
  .strict();

const PauseInput = z.object({ runId: z.string(), reason: z.string().optional() }).strict();
const ResumeInput = z.object({ runId: z.string() }).strict();
const OkOutput = z.object({ ok: z.boolean() }).strict();

const ExportInput = z.object({ runId: z.string() }).strict();
const ExportOutput = z.object({ markdown: z.string() }).strict();

export const DualAgent = Rpc.define({
  id: "dual-agent",
  methods: {
    /** 断线补发：返回 seq 严格大于 since 的事件（升序）。方法名不能叫 events（与 RPC 事件域冲突）。 */
    replay: {
      input: EventsInput,
      output: EventsOutput,
      errors: { run_not_found: RunNotFound },
    },
    /** 运行状态（UI 状态徽标 / 恢复展示）。 */
    status: {
      input: StatusInput,
      output: StatusOutput,
    },
    /** 旁路对话（FR-03）：用户 → 思考模型；返回建议与介入处理方式。 */
    chat: {
      input: ChatInput,
      output: ChatOutput,
      errors: { run_not_found: RunNotFound },
    },
    /** 模型切换（FR-04/06）：scope = task | project | global；运行中切换"下一阶段生效"。 */
    "model.set": {
      input: ModelSetInput,
      output: ModelSetOutput,
    },
    pause: {
      input: PauseInput,
      output: OkOutput,
    },
    resume: {
      input: ResumeInput,
      output: OkOutput,
    },
    /** 过程导出（FR-09）：脱敏后的 Markdown 报告。 */
    export: {
      input: ExportInput,
      output: ExportOutput,
    },
  },
  events: {
    /** 实时过程事件（信封含单调 seq）。 */
    ui: {
      schema: EnvelopeZ as unknown as import("zod").ZodType<
        Readonly<Record<string, unknown>>,
        import("zod").ZodTypeDef,
        unknown
      >,
    },
  },
});

export type DualAgentRpc = typeof DualAgent;

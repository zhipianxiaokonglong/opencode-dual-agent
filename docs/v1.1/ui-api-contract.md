# v1.1 UI ↔ 桥接服务 API 契约

> UI 层只依赖本契约与 `UIEvent` 协议（`src/protocols/ui-event.ts`），不得依赖 OpenCode 内部实现。

## 传输

- 桥接服务默认 `http://127.0.0.1:4700`（仅绑定本地回环）。
- 事件流：`GET /api/events?runId=<id>&since=<seq>` 返回 `text/event-stream`（SSE）。
- 其余为 JSON REST。CORS 允许 UI 开发端口 `http://127.0.0.1:5173`。

## SSE 事件

每个 SSE `message` 的 `data` 为一个 `UIEventEnvelope` JSON：

```jsonc
{
  "seq": 12,                 // 单调序号（每 run 从 1 开始），重连时用 since 补发
  "runId": "run-xxx",
  "at": "2026-09-25T08:00:00.000Z",
  "event": { "type": "stage.changed", "stage": "PLANNING", "at": "...", "note": "" }
}
```

`event.type` 取值（详见 `UIEventSchema`）：

| type | 字段 | UI 展示 |
|---|---|---|
| `run.started` | runId, requirement | 任务标题 + 需求 |
| `stage.changed` | stage, at, note | 阶段时间线（● 完成 / ◐ 当前 / ○ 未达） |
| `planner.output` | kind: analysis\|decision\|plan\|review\|fix, content, payload? | 过程流卡片（可折叠详情） |
| `coder.progress` | taskId, action: read\|edit\|test\|summary, content | 主栏开发过程行 |
| `test.report` | report: {checkId, revision, status, exitCode, failedTests[], logArtifact, durationMs} | 测试结果摘要卡片 |
| `chat.message` | channel: "planner", role: user\|assistant, content | 侧栏对话气泡（user 加"介入"徽标） |
| `model.changed` | channel: planner\|coder, model: {providerID, id} | 选择器同步 + 审计提示 |
| `workflow.paused` / `workflow.resumed` | reason | 状态徽标 + 提示 |
| `run.finished` | runId, status, summary | 终态徽标 |

**脱敏**：桥接服务已对事件内容做脱敏（`[REDACTED:*]`），UI 原样展示即可。

## REST

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/status?runId=` | - | `{ runId, state, stage, round, running, paused, models: { planner: {providerID,id}, coder: {...} } }` |
| POST | `/api/chat` | `{ runId, message }` | `{ reply, action: "inline"\|"consult"\|"review-context"\|"post-task" }` |
| POST | `/api/model` | `{ channel: "planner"\|"coder", model: {providerID, id} \| null, scope: "task"\|"project"\|"global" }` | `{ model, effectiveFrom: "next-stage" }` |
| POST | `/api/pause` | `{ runId, reason? }` | `{ ok: true }` |
| POST | `/api/resume` | `{ runId }` | `{ ok: true }` |
| GET | `/api/export?runId=` | - | `{ markdown }`（FR-09 过程导出，已脱敏） |
| GET | `/api/models` | - | `{ models: Array<{ providerID, id, name?, contextLength?, tools?: boolean }> }`（来自 OpenCode 已配置 provider） |

错误响应：`{ "error": "code", "message": "..." }`，HTTP 4xx/5xx。

## UI 视觉/交互要求（v1.1 §3）

1. **布局**：工具栏（[≡ 侧栏开关] 任务标题 状态徽标 [⏸][⏹][导出]）+ 可收起侧栏 + 主栏（开发模型会话，只读过程视图）。
2. **侧栏**：顶部思考模型选择器；阶段时间线；过程流（卡片带阶段标签/时间戳/模型名/可折叠详情）；底部对话输入框。
3. **侧栏开关**：展开/收起动画 ≤200ms；宽度可拖拽 min 280px / max 480px；收起时新事件在开关上显示角标计数；展开/收起状态持久化（localStorage）。
4. **模型选择器**（侧栏=思考模型，主栏=开发模型）：下拉展示 `GET /api/models` 的模型；运行中切换弹二次确认（"当前阶段结束后生效"）；不可用模型灰置+原因。
5. **对话**：用户消息带"介入"徽标（区别自动流程消息）；`workflow.paused` 时输入框提示"已暂停，回复将进入咨询"；可点"继续"（`POST /api/resume`）。
6. **主栏**：`coder.progress` 逐行渲染（读取文件/修改摘要/测试执行），任务分组（task-001 …），顶部开发模型选择器；任务级操作按钮（重试/跳过/查看差异）可先占位（disabled + tooltip"后续版本"）。
7. **脱敏展示**：`[REDACTED:*]` 以醒目样式（如遮罩色块）渲染。
8. 无障碍基线：按钮均有 aria-label；快捷键 Esc 收起侧栏、Ctrl+K 焦点到对话框。

## 技术栈与目录

- Vite + React 18 + TypeScript + zustand；目录 `ui/`，独立 `package.json`（避免与插件 devDeps 冲突）。
- `ui/src/state/store.ts`：zustand store（events 增量、seq 游标、sidebar 状态、models、status、chat）。
- `ui/src/api/client.ts`：SSE 订阅（自动重连 + since 补发）+ REST 封装；base URL 可通过 `VITE_BRIDGE_URL` 覆盖。
- 组件：`ui/src/components/{Shell,Toolbar,Sidebar/{StageTimeline,ProcessStream,PlannerChat,ModelPicker},Main/CoderSession}.tsx`。
- npm scripts：`dev`（vite）、`build`（tsc && vite build）、`preview`。

## 验收对照（v1.1 §10）

1. 侧栏开关可用 + 持久化 + 角标；2. 过程流实时（SSE）+ 断线 since 补发不丢不乱序；
3. 对话消息经 `/api/chat` 进入编排器介入策略；4. 双选择器独立、三级优先级、切换确认；
5. 脱敏样本不可见（展示 `[REDACTED:*]`）；6. UI 不 import 任何 `src/**`（依赖方向测试）。

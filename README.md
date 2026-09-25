# opencode-dual-agent

OpenCode 双模型协作编码插件：**思考模型规划/评审 + 开发模型写代码 + 真实测试验证** 的自动化开发闭环（《项目文档 v1.0》+ 《v1.1 桌面端双栏交互界面》）。

> 核心原则：模型负责判断，程序负责约束，工具负责证据——任何"完成"结论必须绑定真实测试结果。

## 快速开始

```bash
npm install
npm run typecheck   # 类型检查
npm test            # 单元/集成测试
npm run demo        # P2 演示：对含缺陷示例项目跑完整闭环（真实测试执行）
cd ui && npm install && npm run build   # 构建 v1.1 Web UI
```

## 在 OpenCode 中加载

在目标项目 `opencode.jsonc` 中：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///D:/Program/chajian/opencode-dual-agent",
      "options": {
        "plannerModel": { "providerID": "deepseek", "id": "deepseek-v4-pro" },
        "coderModel": { "providerID": "xiaomi", "id": "mimo-v2.6-pro" },
        "maxRounds": 5,
        "uiPort": 4700
      }
    }
  ]
}
```

| 命令 | 作用 |
|---|---|
| `/dual <需求>` | 启动双模型协作开发闭环 |
| `/dual-probe` | P1 六项能力验证并输出验证报告 |
| `/dual-resume <需求>` | 从最近检查点恢复运行 |

插件选项：`plannerModel` / `coderModel`（角色模型）、`maxRounds` / `maxDurationMs` / `maxCostUsd` / `maxTokens`（预算）、`workspaceBase` / `artifactsBase`、`autoApprove`（CI 无人值守）、`logLevel`、`uiEnabled` / `uiPort` / `uiHost`（v1.1 UI 桥接服务）。

## v1.1：桌面端双栏交互 UI

任务运行时插件在 **`http://127.0.0.1:4700`** 启动 UI 桥接服务（默认仅绑定本机）：

- **侧栏**：思考模型过程流（阶段时间线、分析/决策/评审卡片）、旁路对话输入框、思考模型选择器
- **主栏**：开发模型会话过程（只读 + 任务级操作）、开发模型选择器
- **工具栏**：侧栏开关（状态持久化、收起角标）、暂停/继续、过程导出 Markdown
- **实时事件**：SSE（先落库后推送、单调序号、断线按 seq 补发不丢不乱序）
- **安全**：过程流与导出自动脱敏（`[REDACTED:*]`）；设置 `OPENCODE_DUAL_UI_TOKEN` 后要求 Bearer 鉴权

UI ↔ 后端契约见 `docs/v1.1/ui-api-contract.md`；UI 注入能力验证与路线决定见 `docs/v1.1/P0-ui-injection-report.md`
（结论：**路线 B**——桌面端无插件 UI 注入 API，自建 UI + 插件 RPC/桥接服务驱动，后续可套 Tauri 壳）。

## 工作流（状态机驱动，§4）

```text
CREATED → ANALYZING → PLANNING → WAITING_APPROVAL → IMPLEMENTING ⇄ REVIEWING → FINALIZING → COMPLETED
              │              │                              │
        WAITING_USER   WAITING_APPROVAL              CONSULTING（v1.1 介入咨询）
                                                    REPLANNING / BLOCKED / STOPPED
任意活动状态 → CANCELLED / FAILED
```

- 修复循环 ≤ `maxRounds`（默认 5）；同类问题连续 2 轮无改善 → STOPPED
- 超时 / 超 token / 超费用预算 → STOPPED（仍返回部分成果与差异）
- 测试结果绑定代码 revision，代码变更后旧通过结果作废
- v1.1：用户介入按状态分流（inline / consult / review-context / post-task），
  `IMPLEMENTING`/`VERIFYING` 中介入在**安全点**暂停进入 `CONSULTING`，不打断原子操作

## 架构 ↔ 代码映射（§3 / §6 / v1.1 §4.1）

| 设计模块 | 代码位置 |
|---|---|
| 插件层（事件接入、命令、UI 通道装配） | `src/plugin.ts` |
| 适配层（OpenCode API 全部封装于此） | `src/adapters/`（`opencode-adapter.ts`、`model-gateway.ts`、`recursion-guard.ts`、`capability-probe.ts`、`ui-channel-adapter.ts`） |
| 编排器（状态机/预算/恢复/事件总线/介入） | `src/orchestrator/`（`workflow.ts`、`transitions.ts`、`budget.ts`、`recovery.ts`、`event-bus.ts`、`interventions.ts`） |
| 思考模型（Planner/Reviewer/旁路对话） | `src/agents/`、`prompts/planner-chat.md` |
| 通信协议（Zod Schema + UIEvent） | `src/protocols/`、`src/rpc.ts` |
| 工作区隔离 | `src/workspace/index.ts` |
| 测试执行器 | `src/verification/index.ts` |
| 权限执行层 / 脱敏 | `src/security/permissions.ts`、`src/security/redaction.ts` |
| 持久化（SQLite + JSON 降级） | `src/storage/` |
| 模型设置（任务>项目>全局） | `src/config/model-settings.ts` |
| 交付报告 / 过程导出 | `src/reporting/index.ts` |
| UI 桥接服务（SSE + REST） | `src/ui/server.ts` |
| Web UI（React + zustand） | `ui/` |

## 安全机制（§8，强制项）

| 要求 | 落地 |
|---|---|
| 权限执行层 | 路径白名单 glob + 敏感文件黑名单 + 越界拒绝（`PathGuard`） |
| 禁止模型输出拼接 shell | 命令只接受数组，校验拒绝 shell 元字符，`spawn(shell:false)` |
| 不挂载生产凭证 | 执行环境脱敏（TOKEN/SECRET/KEY/密码类变量不透传） |
| 防"改测试作弊" | diff 扫描标记删测试 / 加 skip / 改断言，需人工审批，未批准记 blocker 并阻止完成 |
| 证据优先 | 评审 `approve` 但存在失败检查或未决 blocker 时，程序以真实证据为准，不宣告完成 |
| 防递归触发 | 根任务 ID + 内部会话映射（SQLite）+ 事件去重键 + 工作区执行锁 |
| 可恢复 | 每阶段检查点（状态/补丁/模型输出/测试证据/预算/问题台账），`/dual-resume` 恢复 |
| 防提示注入 | 仓库文件/日志在提示词中仅作为"数据"注入，模板内含不可覆盖的安全规则 |
| v1.1 过程脱敏 | 过程流/导出正则 + 熵检测遮蔽疑似凭证；旁路对话回答只给建议、不执行修改 |
| v1.1 UI 通道 | 桥接服务默认绑定 127.0.0.1，可选 Bearer 令牌；模型选择器不暴露 API Key |

## 执行隔离的边界（诚实声明）

Git worktree / 副本**只隔离文件，不隔离运行时**。测试/构建/依赖安装的容器化受限执行属于 P3 计划；
当前版本对执行命令做了白名单式受控与环境脱敏，但不构成运行时沙箱。

## 路线图

| 阶段 | 状态 |
|---|---|
| v1.0 P1 兼容性原型 | ✅ 六项能力全部通过（OpenCode 2.0.16，见 `docs/P1-verification.md`） |
| v1.0 P2 MVP 闭环 | ✅ 状态机闭环 + 真实测试证据 + ≤5 轮修复 + §10 报告 |
| v1.0 P3 工程可靠性 | 🚧 恢复/预算/取消/权限/递归防护已实现；容器执行隔离待做 |
| v1.1 P0 UI 能力验证 | ✅ 路线 B（见 `docs/v1.1/P0-ui-injection-report.md`） |
| v1.1 P1-P3 UI/事件/模型设置 | ✅ 交付（Web UI + SSE + 旁路对话 + CONSULTING + 三级模型设置） |
| v1.1 P4 打磨 | 🚧 断线补发/导出/脱敏已交付；Tauri 壳、无障碍细化、快捷键增强待做 |
| v1.0 P4 多语言扩展 | ⬜ |

## 已知限制

- v1.1 UI 当前为 **Web UI 形态**（本地桥接服务托管）；Tauri/Electron 壳打包为后续步骤。
- v1 仅支持 TypeScript 项目（技术栈锁定由规划阶段决定并经用户确认）。
- 非 Git 工作区 `diff()` 返回空（revision 仍按文件树哈希绑定）；建议在 Git 仓库中使用。
- 供应商 `reasoning summary` 展示依赖模型支持，不支持时 UI 自动隐藏该项。

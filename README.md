# opencode-dual-agent

OpenCode 双模型协作编码插件：**思考模型规划/评审 + 开发模型写代码 + 真实测试验证** 的自动化开发闭环（对应《任务概要》v1.0）。

> 核心原则：模型负责判断，程序负责约束，工具负责证据——任何"完成"结论必须绑定真实测试结果。

## 快速开始

```bash
npm install
npm run typecheck   # 类型检查
npm test            # 71 个单元/集成测试
npm run demo        # P2 演示：对含缺陷示例项目跑完整闭环（真实测试执行）
```

## 在 OpenCode 中加载

在目标项目 `opencode.jsonc` 中：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "D:/Program/chajian/opencode-dual-agent",
      "options": {
        "plannerModel": { "providerID": "anthropic", "id": "claude-sonnet-4-6" },
        "coderModel": { "providerID": "anthropic", "id": "claude-sonnet-4-6" },
        "maxRounds": 5,
        "maxDurationMs": 1800000,
        "autoApprove": false
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

插件选项：`plannerModel` / `coderModel`（角色模型）、`maxRounds` / `maxDurationMs` / `maxCostUsd` / `maxTokens`（预算）、`workspaceBase` / `artifactsBase`（工作区与产物目录）、`autoApprove`（CI 无人值守）、`logLevel`。

## 工作流（状态机驱动，§4）

```text
CREATED → ANALYZING → PLANNING → WAITING_APPROVAL → IMPLEMENTING ⇄ REVIEWING → FINALIZING → COMPLETED
              │                                              │
        WAITING_USER                                  REPLANNING / BLOCKED / STOPPED
任意活动状态 → CANCELLED / FAILED
```

- 修复循环 ≤ `maxRounds`（默认 5）；同类问题连续 2 轮无改善 → STOPPED
- 超时 / 超 token / 超费用预算 → STOPPED（仍返回部分成果与差异）
- 测试结果绑定代码 revision，代码变更后旧通过结果作废

## 架构 ↔ 代码映射（§3 / §6）

| 设计模块 | 代码位置 |
|---|---|
| 插件层（事件接入、命令、交互） | `src/plugin.ts` |
| 适配层（OpenCode API 全部封装于此） | `src/adapters/opencode-adapter.ts`、`model-gateway.ts`、`recursion-guard.ts`、`capability-probe.ts` |
| 编排器（状态机/预算/恢复） | `src/orchestrator/workflow.ts`、`transitions.ts`、`budget.ts`、`recovery.ts` |
| 思考模型（Planner/Reviewer） | `src/agents/planner.ts`、`reviewer.ts`、`structured.ts` |
| 开发模型（Coder 提示词与交付） | `src/agents/coder.ts`（会话执行在适配层） |
| 通信协议（Zod Schema 校验） | `src/protocols/`（任务包 / 测试报告 / 评审结论 / 分析 / 规划） |
| 工作区隔离 | `src/workspace/index.ts`（Git worktree / 副本） |
| 测试执行器 | `src/verification/index.ts`（受控命令、产物归档、revision 绑定） |
| 权限执行层 | `src/security/permissions.ts` |
| 持久化（SQLite） | `src/storage/index.ts`（node:sqlite） |
| 交付报告（§10） | `src/reporting/index.ts` |
| 提示词 | `prompts/*.md` |

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

## 执行隔离的边界（诚实声明）

Git worktree / 副本**只隔离文件，不隔离运行时**。测试/构建/依赖安装的容器化受限执行（非特权用户、限 CPU/内存/时间、禁网）属于 P3 计划；当前版本对执行命令做了白名单式受控与环境脱敏，但不构成运行时沙箱。

## 路线图（§9）

| 阶段 | 状态 |
|---|---|
| P1 兼容性原型（六项能力验证） | ✅ 探测器与报告已交付（`/dual-probe`、`docs/P1-verification.md`），需在目标 OpenCode 版本回填结论 |
| P2 MVP 闭环（TS 项目） | ✅ 状态机闭环 + 真实测试证据 + ≤5 轮修复 + §10 报告（`npm run demo`） |
| P3 工程可靠性 | 🚧 崩溃恢复/预算/取消/权限/递归防护已实现；容器执行隔离与独立验收测试待做 |
| P4 扩展 | ⬜ Python/Go/Rust、任务依赖图、PR/补丁交付、成本优化 |

## 已知限制（P2 边界）

- v1 仅支持 TypeScript 项目（技术栈锁定由规划阶段决定并经用户确认）。
- 并行多开发代理、自动部署/自动 push 不做（也被权限层显式禁止）。
- 非 Git 工作区 `diff()` 返回空（revision 仍按文件树哈希绑定）；建议在 Git 仓库中使用。
- 模型协议调用做有限重试；不重放有副作用的命令。

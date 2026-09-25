# P1 兼容性验证报告（§7.2 / §9 P1）

> 状态：**待在目标 OpenCode 版本上运行 `/dual-probe` 回填结论**
> 生成时间：2026-09-25

## 验证方法

1. 将插件加载进目标 OpenCode 版本（见 README「在 OpenCode 中加载」）。
2. 在 TUI 中执行 `/dual-probe`（会做一次真实会话创建探测），或在代码中调用
   `probeCapabilities(ctx, { live: true })`。
3. 将输出的六项能力结论回填到下表，并据此确认路径 A / 路径 B 选型。

探测器实现：`src/adapters/capability-probe.ts`（静态 API 探测 + 可选真实会话探测）。

## 六项能力验证记录（回填）

| # | 能力 | 验证要点 | 结论（✅/❌） | 版本/证据 |
|---|---|---|---|---|
| 1 | 会话隔离 | `session.create` 可创建互不串扰的内部会话（Planner/Reviewer/Coder 各自上下文） | 待回填 | |
| 2 | 按角色指定模型 | `generate.text` 指定模型、`session.switchModel` 按角色切换 | 待回填 | |
| 3 | 生命周期信号 | `session.wait` 感知完成、`session.interrupt` 取消、`event.subscribe` 事件流 | 待回填 | |
| 4 | 工具/文件权限限制 | `permission.rules` / `permission.hook` 落地路径白名单与全拒绝基线 | 待回填 | |
| 5 | 指定工作目录 | `session.create` 的 `directory`/`worktree` 字段或 worktree 域 | 待回填 | |
| 6 | 结果获取 | `session.context` 读取会话产物（代码变更、修改摘要） | 待回填 | |

## 路径选型（§7.2）

- **路径 A（优先验证）**：思考模型与开发模型均通过 OpenCode 会话执行。
  适配层已按路径 A 实现：`SessionCoderExecutor`（会话隔离 + 权限规则 + 工作目录）。
- **路径 B（兜底）**：思考模型走独立模型 API（只读材料 + 结构化输出），开发模型走
  OpenCode 编码执行能力，测试由编排器直接执行。
  当前实现中思考模型走 `ctx.generate.text`（结构化生成、不落会话历史），
  本质上即路径 B 的思考侧；开发侧按路径 A 实现，能力不足时可降级。

**选型决定：待六项能力回填后确认。** 判定规则：

- 6 项全部 ✅ → 采用路径 A；
- 4（权限）或 5（工作目录）为 ❌ → 核心流程走路径 B + 人工审批兜底；
- 3（生命周期）为 ❌ → 取消/超时不可靠，必须启用编排器侧看门狗（已实现超时与预算终止）。

## 递归触发防护验证（§7.3）

| 验证点 | 实现 | 测试 |
|---|---|---|
| 根任务 ID | `RecursionGuard.runId` | `tests/adapters.test.ts` |
| 内部会话 ID / 角色映射 | `session_refs` 表（SQLite） | `tests/adapters.test.ts`、`tests/storage.test.ts` |
| 事件去重键 | `shouldHandle`（type+session+id，有界去重表） | `tests/adapters.test.ts` |
| 工作区执行锁 | 进程级共享锁，跨实例互斥、可重入 | `tests/adapters.test.ts` |

## P1 交付物清单

- [x] 插件加载（`src/plugin.ts`，`Plugin.define` + 命令注册）
- [x] 双角色模型调用（`RoleModelGateway`，角色 → 模型解析）
- [x] 会话隔离与工作区指定（`SessionCoderExecutor` + `FileWorkspace`）
- [x] 结果获取与结构化报告（`buildReport`，§10 规范）
- [x] 取消能力（`AbortSignal` + `session.interrupt` + 状态机 CANCEL 转换）
- [x] 最小原型：调用两个角色并跑通一次真实测试（`npm run demo`）
- [ ] 能力验证报告在目标 OpenCode 版本回填（本文件）

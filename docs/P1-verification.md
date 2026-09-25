# P1 兼容性验证报告（§7.2 / §9 P1）

> 状态：**已完成**（2026-09-25）
> 目标版本：OpenCode **2.0.16**（桌面版，`@opencode/plugin` 2.0.16）
> 验证方式：加载插件后执行 `/dual-probe`（真实会话探测）

## 验证方法

1. 将插件加载进目标 OpenCode 版本（见 README「在 OpenCode 中加载」）。
2. 在 TUI 中执行 `/dual-probe`（会做一次真实会话创建探测），或在代码中调用
   `probeCapabilities(ctx, { live: true })`。
3. 将输出的六项能力结论回填到下表，并据此确认路径 A / 路径 B 选型。

探测器实现：`src/adapters/capability-probe.ts`（静态 API 探测 + 可选真实会话探测）。

## 六项能力验证记录（已回填）

| # | 能力 | 验证要点 | 结论 | 版本/证据 |
|---|---|---|---|---|
| 1 | 会话隔离 | `session.create` 可创建互不串扰的内部会话 | ✅ 通过 | 2.0.16；真实创建两个独立会话验证 |
| 2 | 按角色指定模型 | `generate.text` 指定模型、`session.switchModel` 按角色切换 | ✅ 通过 | 2.0.16 |
| 3 | 生命周期信号 | `session.wait` 感知完成、`session.interrupt` 取消、`event.subscribe` 事件流 | ✅ 通过 | 2.0.16 |
| 4 | 工具/文件权限限制 | `permission.rules` / `permission.hook` 落地路径白名单 | ✅ 通过 | 2.0.16 |
| 5 | 指定工作目录 | `session.create` 的 `directory`/`worktree` 字段或 worktree 域 | ✅ 通过 | 2.0.16 |
| 6 | 结果获取 | `session.context` 读取会话产物 | ✅ 通过 | 2.0.16 |

## 路径选型（§7.2）——最终决定

**采用路径 A**（双 OpenCode 会话）：6 项能力全部满足，开发模型走 OpenCode 会话
（会话隔离 + 权限规则 + 指定工作目录），思考模型走 `ctx.generate.text` 结构化生成
（同属路径 A 能力面，不落会话历史、不需要工具）。
路径 B 保留为未来多模型供应商直连的兜底实现。

## 其他验证发现（安装/加载相关）

- 插件包目录入口需为 `index.ts`（`export { default } from "./src/plugin"`）；
  仅在 `package.json` 声明 `main` 不足以被 `.opencode/plugins/` 自动加载解析。
- 全局配置 `plugins` 支持 `file:///盘符:/路径` 形式的本地插件；纯 Windows 盘符路径
  （`D:/...`）可能被静默忽略。
- 插件按**位置懒加载**：`/api/plugin?location[directory]=...` 查询对应位置才能看到；
  修改全局插件配置后需重启后台服务（`opencode service restart`）。
- 命令执行器内投递合成消息（`session.synthetic`）到繁忙会话可能长时间阻塞，
  已用超时保护包住（`safeSynthetic`）。

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

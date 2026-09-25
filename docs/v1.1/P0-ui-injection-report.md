# v1.1 P0 —— UI 注入能力验证报告（§7 决策门）

> 状态：**已完成**（2026-09-25）
> 目标版本：OpenCode **2.0.16**（桌面版 `@opencode-aidesktop` + 后台服务）
> 结论：**采用路线 B（自建 UI + 服务接口驱动）**；TUI 插件槽位可作后续补充形态

## 1. 验证项与证据

| # | 验证项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 桌面端（Electron 壳）插件 UI 注入（侧栏/面板/按钮/双栏） | ❌ **不支持** | 官方 V2 文档无桌面端 UI 扩展章节；`@opencode/plugin` 2.0.16 包内无桌面 UI 扩展面（仅 `promise`/`effect`/`tui`/`host` 导出）；桌面端定位为"连接服务的客户端"，非可扩展宿主 |
| 2 | TUI 插件 UI 扩展（终端形态） | ✅ 支持（能力很强） | `/v2/docs/build/plugins/cli`：`@opencode/plugin/tui` 提供 slots（含 `sidebar.content`、`sidebar.footer`、`session.panel`、`app`）、路由、对话框、toast、keymap、SolidJS 组件渲染 |
| 3 | 插件自定义 RPC（方法 + 事件，HTTP 可达） | ✅ 支持 | `/v2/docs/build/plugins/rpc`：`Rpc.define` + `ctx.rpc.register`；外部客户端经 `@opencode/client` 的 `client.rpc(...)` 调用与订阅事件 |
| 4 | 服务端 Web UI 可注入自定义界面 | ❌ 不支持 | `/v2/docs/cli/web`：Web UI 为内置只读客户端，仅可配 host/port/cors，无插件 UI 注入 |
| 5 | 事件订阅补发 | ⚠️ 需自建 | RPC 事件"仅实时订阅，断线丢失"（官方文档明示）→ 必须自建持久化事件序号 + 补发（v1.1 §4.2 要求，正好由编排器 SQLite `events` 表实现） |

## 2. 路线决定

**路线 B：自建 UI + 服务接口驱动。**

- UI 形态：**React + zustand 的 Web UI**（本地桥接服务提供 SSE 事件流 + REST），
  后续套 **Tauri** 壳即为桌面应用（UI 代码 0 改动）；本次不做壳打包（见 §4）。
- 后端驱动：**插件 RPC**（`dual-agent` 命名空间）承载 UI ↔ 编排器全部交互
  （事件流、旁路对话、模型切换、暂停/恢复、导出），外部经 `@opencode/client` 调用。
- 依赖方向约束（v1.1 §7 设计约束）：UI 层只依赖 `ui-channel-adapter` 暴露的
  协议（`UIEvent` + RPC 接口），**不依赖** OpenCode 内部实现；
  业务层（orchestrator/agents/protocols/verification）保持 v1.0 不变的可移植性。

> 路线 A 判定为不可行的原因：桌面端无任何插件 UI 扩展点。TUI 槽位（验证项 2）
> 能力覆盖侧栏/面板需求，但属于终端形态；若未来需要终端版，可复用同一套
> `UIEvent` 协议与事件总线做 TUI 渲染层，不影响现有架构。

## 3. UI 通道技术决定

| 决定 | 内容 |
|---|---|
| 事件传输 | 插件 RPC 事件 `dual-agent.ui`（实时）+ 方法 `dual-agent.replay`（按序号补发） |
| 事件持久化 | SQLite `events` 表，单调递增 `seq`；**先落库后推送**（v1.1 §4.2） |
| 断线重连 | UI 携带最后 `seq` 重连，`replay({ since })` 补发后再接实时流 |
| 鉴权 | 桥接服务默认绑定 `127.0.0.1`；远程访问需显式配置并鉴权（v1.1 §8.4） |
| 桥接服务 | `src/ui/server.ts`：静态托管 UI + SSE + REST → `@opencode/client` RPC |

## 4. 本次交付范围（对应 §9 阶段）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 能力验证 | ✅ 本报告 | 路线 B 已定 |
| P1 UI 骨架 | ✅ 交付 | 双栏布局、侧栏开关（localStorage 持久化）、模型选择器、事件回放缓存 |
| P2 过程流与双会话 | ✅ 交付 | 事件总线/推送、过程流渲染、旁路对话、`CONSULTING` 状态与介入策略 |
| P3 模型设置 | ✅ 交付 | 三级优先级（任务>项目>全局）、运行中切换"下阶段生效"、审计事件 |
| P4 打磨 | 🚧 部分 | 断线补发 ✅、导出 Markdown ✅、脱敏 ✅；无障碍/快捷键后续 |

未做（明确非目标）：Tauri/Electron 壳打包（Web UI 可直接运行，壳为打包步骤）、
移动端、多任务多标签。

## 5. 待回填（P4 结束后）

1. Tauri 壳打包验证（窗口尺寸/系统托盘/签名）。
2. 供应商 `reasoning summary` 字段逐一确认（§3.3 展示项 6）；不支持则该项在 UI 隐藏。

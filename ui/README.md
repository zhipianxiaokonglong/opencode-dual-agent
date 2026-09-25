# opencode-dual-agent-ui

OpenCode 双模型协作插件 v1.1 桌面端 UI 的 Web 形态（Vite + React 18 + TypeScript + zustand）。

- 仅依赖 `docs/v1.1/ui-api-contract.md` 与 `UIEvent` 协议（类型复制于 `src/protocols/ui-event.ts`，不 import `src/**`）。
- 桥接服务默认 `http://127.0.0.1:4700`，可用环境变量 `VITE_BRIDGE_URL` 覆盖（如 `.env.local`）。

## 命令

```bash
npm install
npm run dev       # 开发（http://127.0.0.1:5173，端口固定以匹配桥接 CORS）
npm run build     # tsc --noEmit && vite build
npm run preview   # 预览产物（http://127.0.0.1:4173）
```

## 目录

```
ui/src/
  api/client.ts          REST + SSE（断线重连 since 补发）
  state/store.ts         zustand：事件缓冲/seq 游标/侧栏/模型/状态/对话
  protocols/ui-events.ts UIEvent/Envelope 类型（复制，不依赖 src/**）
  components/
    Shell.tsx            双栏布局 + 快捷键 + 侧栏拖拽
    Toolbar.tsx          [≡] 标题 状态徽标 [⏸][⏹][导出]
    Sidebar/{ModelPicker,StageTimeline,ProcessStream,PlannerChat}.tsx
    Main/CoderSession.tsx 开发模型会话（只读过程视图）
    RedactedText.tsx     [REDACTED:*] 遮罩渲染
  styles.css             深色主题纯 CSS
```

## 快捷键

- `Esc`：收起侧栏
- `Ctrl+K`（macOS `Cmd+K`）：聚焦对话输入框
- 对话输入：`Enter` 发送，`Shift+Enter` 换行

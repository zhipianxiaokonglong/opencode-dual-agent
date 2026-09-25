/**
 * P1 兼容性验证（§7.2 / §9 P1）：
 * 对目标 OpenCode 版本完成 6 项能力的最小验证，输出能力验证报告。
 * 不允许依赖未公开内部接口实现核心流程——能力缺失时走路径 B 或降级。
 */
import type { OpenCodeContextLike } from "./opencode-adapter";

export interface CapabilityReport {
  id: string;
  name: string;
  supported: boolean;
  detail: string;
}

export async function probeCapabilities(
  ctx: OpenCodeContextLike,
  opts: { live?: boolean } = {},
): Promise<CapabilityReport[]> {
  const reports: CapabilityReport[] = [];
  const has = (fn: unknown) => typeof fn === "function";

  // 1. 会话隔离
  let sessionOk = has(ctx.session?.create) && has(ctx.session?.context);
  let sessionDetail = sessionOk ? "session.create / session.context 可用" : "缺少 session.create 或 session.context";
  if (opts.live && sessionOk) {
    try {
      const a = await ctx.session.create({ title: "dual-probe-a" });
      const b = await ctx.session.create({ title: "dual-probe-b" });
      sessionOk = a.id !== b.id;
      sessionDetail = sessionOk
        ? `可创建独立会话（${a.id} / ${b.id}）`
        : "会话创建返回相同 ID，隔离性存疑";
    } catch (err) {
      sessionOk = false;
      sessionDetail = `会话创建失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  reports.push({ id: "session-isolation", name: "会话隔离", supported: sessionOk, detail: sessionDetail });

  // 2. 按角色指定模型
  const modelOk = has(ctx.generate?.text) && has(ctx.session?.switchModel);
  reports.push({
    id: "role-model",
    name: "按角色指定模型",
    supported: modelOk,
    detail: modelOk
      ? "generate.text 可指定模型，session.switchModel 可用"
      : "generate.text 或 session.switchModel 不可用，需回退到统一模型",
  });

  // 3. 生命周期信号（等待 / 中断 / 取消）
  const lifecycleOk = has(ctx.session?.wait) && has(ctx.session?.interrupt) && has(ctx.event?.subscribe);
  reports.push({
    id: "lifecycle",
    name: "生命周期信号（wait/interrupt/取消）",
    supported: lifecycleOk,
    detail: lifecycleOk
      ? "session.wait / session.interrupt / event.subscribe 可用"
      : "生命周期 API 缺失，无法可靠获取完成/取消信号",
  });

  // 4. 工具 / 文件权限限制
  const permissionOk = has(ctx.permission?.rules) || has((ctx.permission as Record<string, unknown>)?.hook);
  reports.push({
    id: "permissions",
    name: "工具/文件权限限制",
    supported: permissionOk,
    detail: permissionOk
      ? "permission.rules / permission.hook 可用，可落地路径白名单"
      : "无会话级权限控制，只能提示词约束 + 差异审计（不满足安全强制项）",
  });

  // 5. 指定工作目录
  const workdirOk = has((ctx as unknown as Record<string, unknown>).worktree) || ctx.location?.directory !== undefined;
  reports.push({
    id: "workdir",
    name: "指定工作目录",
    supported: workdirOk,
    detail: workdirOk
      ? "可指定工作区目录（session.create directory/worktree 字段或 worktree 域）"
      : "无法指定工作目录，工作区隔离不可用",
  });

  // 6. 结果获取
  const resultOk = has(ctx.session?.context);
  reports.push({
    id: "result-retrieval",
    name: "结果获取",
    supported: resultOk,
    detail: resultOk ? "session.context 可读取会话产物" : "无法读取会话结果",
  });

  return reports;
}

export function formatCapabilityReport(reports: readonly CapabilityReport[]): string {
  const lines = ["# P1 能力验证报告", ""];
  lines.push("| 能力 | 结论 | 说明 |");
  lines.push("|---|---|---|");
  for (const r of reports) {
    lines.push(`| ${r.name} | ${r.supported ? "✅ 通过" : "❌ 不支持"} | ${r.detail} |`);
  }
  const allOk = reports.every((r) => r.supported);
  lines.push("");
  lines.push(
    allOk
      ? "**结论：6 项能力全部满足，可采用路径 A（双 OpenCode 会话）。**"
      : "**结论：存在能力缺口，核心流程需走路径 B 或启用降级方案（§7.2）。**",
  );
  return lines.join("\n");
}

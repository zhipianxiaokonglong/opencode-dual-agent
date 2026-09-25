import { describe, expect, it } from "vitest";
import { RecursionGuard } from "../src/adapters/recursion-guard";
import { SqliteStore } from "../src/storage";
import { RoleModelGateway } from "../src/adapters/model-gateway";
import { silentLogger } from "../src/logging";

describe("递归触发防护（§7.3）", () => {
  it("内部会话事件被忽略，外部事件去重", async () => {
    const guard = new RecursionGuard("run-1");
    await guard.registerSession("coder", "ses-internal");

    expect(guard.isInternal("ses-internal")).toBe(true);
    expect(guard.shouldHandle({ type: "message.updated", sessionID: "ses-internal", id: "m1" })).toBe(false);
    expect(guard.shouldHandle({ type: "message.updated", sessionID: "ses-user", id: "m2" })).toBe(true);
    expect(guard.shouldHandle({ type: "message.updated", sessionID: "ses-user", id: "m2" })).toBe(false); // 去重
  });

  it("内部会话映射落库（SQLite）", async () => {
    const store = new SqliteStore();
    const guard = new RecursionGuard("run-2", store);
    await guard.registerSession("planner", "ses-p");
    await guard.registerSession("coder", "ses-c");
    const refs = await store.listSessionRefs("run-2");
    expect(refs.map((r) => r.role).sort()).toEqual(["coder", "planner"]);
    await store.close();
  });

  it("工作区执行锁互斥", () => {
    const a = new RecursionGuard("run-a");
    const b = new RecursionGuard("run-b");
    expect(a.acquireWorkspaceLock("/ws")).toBe(true);
    expect(b.acquireWorkspaceLock("/ws")).toBe(false);
    expect(a.acquireWorkspaceLock("/ws")).toBe(true); // 重入
    a.releaseWorkspaceLock("/ws");
    expect(b.acquireWorkspaceLock("/ws")).toBe(true);
  });
});

describe("RoleModelGateway", () => {
  it("按角色解析模型，缺省回落默认模型", async () => {
    const calls: string[] = [];
    const gateway = new RoleModelGateway(
      async ({ model }) => {
        calls.push(`${model.providerID}/${model.id}`);
        return { text: "{}" };
      },
      {
        planner: { providerID: "anthropic", id: "planner-model" },
        reviewer: { providerID: "anthropic", id: "reviewer-model" },
        default: { providerID: "anthropic", id: "default-model" },
      },
      silentLogger,
    );

    await gateway.generate({ role: "planner", system: "s", prompt: "p" });
    await gateway.generate({ role: "reviewer", system: "s", prompt: "p" });
    expect(calls).toEqual(["anthropic/planner-model", "anthropic/reviewer-model"]);
  });
});

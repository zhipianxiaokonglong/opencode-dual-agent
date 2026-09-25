import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStore } from "../src/storage";
import { restoreRun, saveCheckpoint } from "../src/orchestrator/recovery";

const stores: SqliteStore[] = [];
function makeStore(dbPath = ":memory:"): SqliteStore {
  const store = new SqliteStore(dbPath);
  stores.push(store);
  return store;
}

afterEach(async () => {
  while (stores.length) await stores.pop()!.close();
});

describe("SqliteStore", () => {
  it("检查点保存与读取最新", async () => {
    const store = makeStore();
    await saveCheckpoint(store, {
      runId: "r1",
      state: "ANALYZING",
      round: 0,
      payload: { requirement: "x", reports: [], issues: [], changedFiles: [], userAnswers: {} },
    });
    await saveCheckpoint(store, {
      runId: "r1",
      state: "IMPLEMENTING",
      round: 1,
      payload: { requirement: "x", reports: [], issues: [], changedFiles: [], userAnswers: {} },
    });

    const latest = await store.latestCheckpoint("r1");
    expect(latest?.state).toBe("IMPLEMENTING");
    expect(latest?.round).toBe(1);
  });

  it("问题台账 upsert 与状态流转", async () => {
    const store = makeStore();
    await store.addIssues("r1", [
      {
        issueId: "ISSUE-001",
        summary: "重复邮箱未拒绝",
        severity: "blocker",
        status: "open",
        relatedCriteria: ["AC-01"],
        location: "src/auth.ts",
        round: 1,
      },
    ]);
    await store.addIssues("r1", [
      {
        issueId: "ISSUE-001",
        summary: "重复邮箱未拒绝",
        severity: "blocker",
        status: "fixed",
        relatedCriteria: ["AC-01"],
        location: "src/auth.ts",
        round: 2,
      },
    ]);
    await store.updateIssueStatus("r1", "ISSUE-001", "verified");
    const issues = await store.listIssues("r1");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.status).toBe("verified");
  });

  it("内部会话映射与 meta（§7.3）", async () => {
    const store = makeStore();
    await store.putSessionRef("r1", "coder", "ses-abc");
    await store.putSessionRef("r1", "coder", "ses-abc"); // 幂等
    await store.setMeta("r1", "rootTask", "task-001");
    expect(await store.listSessionRefs("r1")).toEqual([{ role: "coder", sessionKey: "ses-abc" }]);
    expect(await store.getMeta("r1", "rootTask")).toBe("task-001");
  });

  it("文件型 SQLite 可持久化", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-store-"));
    const dbPath = path.join(dir, "state.sqlite");
    const store = makeStore(dbPath);
    await saveCheckpoint(store, {
      runId: "r2",
      state: "PLANNING",
      round: 0,
      payload: { requirement: "y", reports: [], issues: [], changedFiles: [], userAnswers: {} },
    });
    await store.close();

    const reopened = makeStore(dbPath);
    const restored = await restoreRun(reopened, "r2");
    expect(restored?.state).toBe("PLANNING");
    expect(restored?.payload.requirement).toBe("y");
    await reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("恢复时载荷不符合 Schema 则拒绝", async () => {
    const store = makeStore();
    await store.saveCheckpoint({
      runId: "r3",
      state: "PLANNING",
      round: 0,
      createdAt: new Date().toISOString(),
      payload: { junk: true },
    });
    expect(await restoreRun(store, "r3")).toBeUndefined();
    expect(await restoreRun(store, "missing")).toBeUndefined();
  });
});

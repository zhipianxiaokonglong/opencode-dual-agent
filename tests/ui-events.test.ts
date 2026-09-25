import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/storage";
import { EventBus } from "../src/orchestrator/event-bus";
import { UIEventSchema, UIEventEnvelopeSchema } from "../src/protocols/ui-event";
import { exportProcessMarkdown } from "../src/reporting";
import { redactText, redactValue, isSecretLike, entropyOf } from "../src/security/redaction";

describe("UIEvent 协议（§4.2）", () => {
  it("事件 Schema 校验", () => {
    const ok = UIEventSchema.safeParse({
      type: "stage.changed",
      stage: "PLANNING",
      at: new Date().toISOString(),
      note: "",
    });
    expect(ok.success).toBe(true);

    const bad = UIEventSchema.safeParse({ type: "stage.changed", stage: "NOPE", at: "x" });
    expect(bad.success).toBe(false);
  });

  it("信封 Schema 校验", () => {
    const env = UIEventEnvelopeSchema.parse({
      seq: 1,
      runId: "run-1",
      at: new Date().toISOString(),
      event: { type: "run.started", runId: "run-1", requirement: "x" },
    });
    expect(env.seq).toBe(1);
  });
});

describe("EventBus：先落库后推送 + 断线补发（§4.2）", () => {
  it("事件单调编号、订阅收到、按 seq 补发", async () => {
    const store = new SqliteStore();
    const bus = new EventBus(store, "run-1");
    const received: number[] = [];
    bus.subscribe((e) => received.push(e.seq));

    await bus.emit({ type: "run.started", runId: "run-1", requirement: "做一件事" });
    await bus.emit({ type: "stage.changed", stage: "ANALYZING", at: "t", note: "" });
    await bus.emit({ type: "stage.changed", stage: "PLANNING", at: "t", note: "" });

    expect(received).toEqual([1, 2, 3]);

    // 断线补发：since=1 得到 2、3
    const replay = await bus.since(1);
    expect(replay.map((e) => e.seq)).toEqual([2, 3]);
    // 事件顺序不乱
    const all = await bus.since(0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    await store.close();
  });

  it("多订阅者互不影响；单个异常不影响其他", async () => {
    const store = new SqliteStore();
    const bus = new EventBus(store, "run-2");
    const got: number[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => got.push(e.seq));
    await bus.emit({ type: "run.started", runId: "run-2", requirement: "x" });
    expect(got).toEqual([1]);
    await store.close();
  });
});

describe("脱敏（§8.1）", () => {
  it("正则识别常见凭证", () => {
    expect(redactText("token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")).toContain("[REDACTED:github-token]");
    expect(redactText('api_key = "sk-abcdefghijklmnopqrstuvwx"')).toContain("[REDACTED");
    expect(redactText("password: hunter2hunter2")).toContain("[REDACTED:credential]");
  });

  it("高熵字符串兜底", () => {
    expect(entropyOf("aaaaaaaaaa")).toBeLessThan(1);
    expect(isSecretLike("a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6")).toBe(true);
    expect(isSecretLike("hello")).toBe(false);
    expect(redactText("value a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6 here")).toContain("[REDACTED:entropy]");
  });

  it("结构化脱敏递归", () => {
    const out = redactValue({
      content: "key sk-abcdefghijklmnopqrstuvwx used",
      nested: [{ text: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234" }],
      keep: 42,
    });
    expect(out.content).toContain("[REDACTED");
    expect(out.nested[0]!.text).toContain("[REDACTED");
    expect(out.keep).toBe(42);
  });
});

describe("过程导出 Markdown（FR-09）", () => {
  it("包含阶段时间线/过程流/对话且已脱敏", async () => {
    const store = new SqliteStore();
    const bus = new EventBus(store, "run-9");
    await bus.emit({ type: "run.started", runId: "run-9", requirement: "实现 add" });
    await bus.emit({ type: "stage.changed", stage: "ANALYZING", at: "2026-09-25T00:00:00Z", note: "" });
    await bus.emit({
      type: "planner.output",
      kind: "analysis",
      content: "使用 sk-abcdefghijklmnopqrstuvwx 调用",
    });
    await bus.emit({
      type: "test.report",
      report: {
        checkId: "test",
        revision: "rev-1",
        profile: "library",
        status: "failed",
        exitCode: 1,
        failedTests: [{ name: "add works", summary: "expected 3" }],
        logArtifact: "a.log",
        durationMs: 3,
      },
    });

    const md = exportProcessMarkdown({
      runId: "run-9",
      requirement: "实现 add",
      state: "REVIEWING",
      round: 1,
      stageModels: { ANALYZING: "deepseek/deepseek-v4-pro" },
      events: await bus.since(0),
      chatLog: [
        { role: "user", content: "改成支持字符串" },
        { role: "assistant", content: "建议下一轮增加归一化" },
      ],
    });

    expect(md).toContain("## 阶段时间线");
    expect(md).toContain("ANALYZING");
    expect(md).toContain("## 过程流（思考模型）");
    expect(md).toContain("## 思考模型对话（旁路）");
    expect(md).toContain("用户（介入）");
    expect(md).toContain("deepseek/deepseek-v4-pro");
    expect(md).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(md).toContain("[REDACTED");
    await store.close();
  });
});

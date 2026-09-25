import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/storage";
import { FilePromptSource } from "../src/prompts";
import { silentLogger } from "../src/logging";
import { Planner } from "../src/agents/planner";
import { classifyIntervention, PauseController } from "../src/orchestrator/interventions";
import { WorkflowMachine, nextState } from "../src/orchestrator/transitions";
import { ModelSettings, parseModelRef, formatModelRef } from "../src/config/model-settings";
import { UIChannel, type WorkflowController } from "../src/adapters/ui-channel-adapter";
import { EventBus } from "../src/orchestrator/event-bus";
import { runWorkflow } from "../src/orchestrator/workflow";
import {
  ANALYSIS_OK,
  FakeApprovals,
  FakeCoder,
  FakeGateway,
  FakeVerifier,
  FakeWorkspace,
  makeReport,
  planFixture,
  reviewFixture,
} from "./helpers";

describe("介入策略（§5.2）", () => {
  it("按状态分类", () => {
    expect(classifyIntervention("ANALYZING")).toBe("inline");
    expect(classifyIntervention("PLANNING")).toBe("inline");
    expect(classifyIntervention("WAITING_USER")).toBe("inline");
    expect(classifyIntervention("IMPLEMENTING")).toBe("consult");
    expect(classifyIntervention("VERIFYING")).toBe("consult");
    expect(classifyIntervention("REVIEWING")).toBe("review-context");
    expect(classifyIntervention("COMPLETED")).toBe("post-task");
    expect(classifyIntervention("STOPPED")).toBe("post-task");
  });
});

describe("CONSULTING 状态（§5.1）", () => {
  it("实现中介入 → 咨询 → 回到实现", () => {
    expect(nextState("IMPLEMENTING", "CONSULT_START")).toBe("CONSULTING");
    expect(nextState("CONSULTING", "CONSULT_RESUME_IMPL")).toBe("IMPLEMENTING");
    expect(nextState("CONSULTING", "CONSULT_RESUME_VERIFY")).toBe("VERIFYING");
    expect(nextState("CONSULTING", "CONSULT_REPLAN")).toBe("PLANNING");
  });

  it("咨询中仍可取消", () => {
    const m = new WorkflowMachine();
    m.send("START");
    m.send("ANALYSIS_READY");
    m.send("PLAN_READY");
    m.send("PLAN_APPROVED");
    m.send("CONSULT_START");
    expect(m.state).toBe("CONSULTING");
    expect(m.can("CANCEL")).toBe(true);
  });
});

describe("PauseController（安全点暂停）", () => {
  it("暂停在安全点生效，resume 唤醒", async () => {
    const events: string[] = [];
    const pause = new PauseController({
      onPause: (r) => void events.push(`paused:${r}`),
      onResume: (r) => void events.push(`resumed:${r}`),
    });

    pause.request("用户介入");
    let released = false;
    const waiting = pause.safePoint("task-1").then(() => (released = true));

    await new Promise((r) => setTimeout(r, 10));
    expect(released).toBe(false); // 挂起中
    expect(pause.paused).toBe(true);

    pause.resume();
    await waiting;
    expect(released).toBe(true);
    expect(events).toEqual(["paused:用户介入", "resumed:user-resumed"]);
  });

  it("未请求暂停时安全点直接通过", async () => {
    const pause = new PauseController();
    await pause.safePoint("x"); // 不应挂起
    expect(pause.paused).toBe(false);
  });
});

describe("模型设置三级优先级（§6.2）", () => {
  it("任务 > 项目 > 全局", () => {
    const settings = ModelSettings.memory();
    settings.setDefault("planner", parseModelRef("deepseek/deepseek-v4-pro")!);
    settings.setProjectOverride("planner", "D:\\proj", parseModelRef("xiaomi/mimo-v2.6-pro")!);

    // 全局
    expect(settings.resolve("planner", "other")).toEqual({
      providerID: "deepseek",
      id: "deepseek-v4-pro",
    });
    // 项目覆盖
    expect(settings.resolve("planner", "D:\\proj")).toEqual({
      providerID: "xiaomi",
      id: "mimo-v2.6-pro",
    });
    // 任务覆盖最高
    expect(
      settings.resolve("planner", "D:\\proj", { providerID: "opencode", id: "big-pickle" }),
    ).toEqual({ providerID: "opencode", id: "big-pickle" });

    // 未配置返回 null
    expect(settings.resolve("coder")).toBeNull();
  });

  it("解析与格式化模型引用", () => {
    expect(parseModelRef("a/b")).toEqual({ providerID: "a", id: "b" });
    expect(parseModelRef("nope")).toBeNull();
    expect(parseModelRef(null)).toBeNull();
    expect(formatModelRef({ providerID: "a", id: "b/c" })).toBe("a/b/c");
  });
});

describe("旁路对话（FR-03）", () => {
  it("思考模型只给建议，输出纯文本", async () => {
    const gateway = new FakeGateway({ chat: ["建议在下一阶段增加归一化处理"] });
    const planner = new Planner(gateway, new FilePromptSource(), silentLogger);
    const { reply } = await planner.sideChat({
      context: {
        requirement: "修复 add",
        reports: [],
        issues: [],
      },
      history: [{ role: "user", content: "之前的问题" }],
      message: "要不要支持字符串？",
    });
    expect(reply).toContain("建议");
    expect(gateway.consumed).toEqual(["chat"]);
  });
});

describe("UI 通道（ui-channel-adapter）", () => {
  it("handlers 委托到运行控制器；事件订阅脱敏", async () => {
    const channel = new UIChannel(silentLogger);
    const store = new SqliteStore();
    const bus = new EventBus(store, "run-x");
    const chatCalls: string[] = [];

    const controller: WorkflowController = {
      status: () => ({
        runId: "run-x",
        state: "IMPLEMENTING",
        stage: "IMPLEMENTING",
        round: 1,
        running: true,
        paused: false,
        models: {},
      }),
      chat: async (m) => {
        chatCalls.push(m);
        return { reply: "建议", action: "consult" };
      },
      setModel: ({ model }) => ({ model, effectiveFrom: "next-stage" }),
      pause: () => {},
      resume: () => {},
      exportMarkdown: async () => "# md",
    };
    channel.register(controller);
    channel.attachBus("run-x", bus);

    const handlers = channel.handlers();
    const ctx = {
      error(type: string, message: string): never {
        throw new Error(`${type}: ${message}`);
      },
    };

    // 补发
    await bus.emit({ type: "run.started", runId: "run-x", requirement: "x" });
    const replay = (await handlers.replay!({ runId: "run-x", since: 0 }, ctx)) as {
      events: Array<{ seq: number }>;
    };
    expect(replay.events).toHaveLength(1);

    // 状态
    const status = (await handlers.status!({ runId: "run-x" }, ctx)) as { round: number };
    expect(status.round).toBe(1);

    // 对话
    const chat = (await handlers.chat!({ runId: "run-x", message: "hi" }, ctx)) as {
      action: string;
    };
    expect(chat.action).toBe("consult");
    expect(chatCalls).toEqual(["hi"]);

    // 订阅脱敏
    const got: string[] = [];
    channel.subscribe("run-x", (e) => got.push(JSON.stringify(e)));
    await bus.emit({
      type: "planner.output",
      kind: "analysis",
      content: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234",
    });
    expect(got[0]).toContain("[REDACTED");
    expect(got[0]).not.toContain("ghp_");
    await store.close();
  });
});

describe("工作流 UI 事件集成（§4.2）", () => {
  it("端到端运行发出阶段时间线与结果事件，序号连续", async () => {
    const store = new SqliteStore();
    const gateway = new FakeGateway({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
      review: [reviewFixture("approve")],
    });
    let attachedBus: EventBus | undefined;

    const result = await runWorkflow(
      {
        gateway,
        coder: new FakeCoder(),
        verifier: new FakeVerifier((input) => [makeReport(input.revision)]),
        workspace: new FakeWorkspace(),
        approvals: new FakeApprovals(),
        store,
        prompts: new FilePromptSource(),
        logger: silentLogger,
        runHandle: {
          attach(_controller, bus) {
            attachedBus = bus;
          },
        },
      },
      { requirement: "实现 add" },
    );

    expect(result.status).toBe("completed");
    expect(result.stageModels).toBeDefined();

    const events = await attachedBus!.since(0);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // 不乱序
    expect(new Set(seqs).size).toBe(seqs.length); // 不重复

    const types = events.map((e) => e.event.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("stage.changed");
    expect(types).toContain("planner.output");
    expect(types).toContain("test.report");
    expect(types).toContain("coder.progress");
    expect(types[types.length - 1]).toBe("run.finished");

    const stages = events
      .filter((e) => e.event.type === "stage.changed")
      .map((e) => (e.event as { stage: string }).stage);
    expect(stages[0]).toBe("ANALYZING");
    expect(stages).toContain("COMPLETED");
    await store.close();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/storage";
import { EventBus } from "../src/orchestrator/event-bus";
import { UIChannel, type WorkflowController } from "../src/adapters/ui-channel-adapter";
import { startUIServer, type UIServer } from "../src/ui/server";
import { silentLogger } from "../src/logging";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("v1.1 验收 #6：依赖方向（UI 不依赖业务实现）", () => {
  it("ui/src 不 import 任何 src/**", () => {
    const uiSrc = path.join(repoRoot, "ui", "src");
    expect(fs.existsSync(uiSrc)).toBe(true);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, "utf8");
        const re = /from\s+["']([^"']+)["']/g;
        for (const m of content.matchAll(re)) {
          const spec = m[1] ?? "";
          if (/^(\.\.\/)*src\//.test(spec) || spec.startsWith("@/src")) {
            offenders.push(`${path.relative(repoRoot, full)} → ${spec}`);
          }
        }
      }
    };
    walk(uiSrc);
    expect(offenders).toEqual([]);
  });
});

describe("v1.1 UI 桥接服务（SSE + REST）", () => {
  let server: UIServer | undefined;
  let store: SqliteStore | undefined;

  afterEach(async () => {
    await server?.close();
    await store?.close();
    server = undefined;
    store = undefined;
  });

  function makeController(): WorkflowController {
    return {
      status: () => ({
        runId: "run-s",
        state: "IMPLEMENTING",
        stage: "IMPLEMENTING",
        round: 2,
        running: true,
        paused: false,
        models: { planner: { providerID: "deepseek", id: "deepseek-v4-pro" } },
      }),
      chat: async () => ({ reply: "建议", action: "consult" }),
      setModel: ({ model }) => ({ model, effectiveFrom: "next-stage" }),
      pause: () => {},
      resume: () => {},
      exportMarkdown: async () => "# 导出",
    };
  }

  it("REST：status / chat / export / models；SSE：since 补发", async () => {
    store = new SqliteStore();
    const channel = new UIChannel(silentLogger);
    channel.register(makeController());
    const bus = new EventBus(store, "run-s");
    channel.attachBus("run-s", bus);
    await bus.emit({ type: "run.started", runId: "run-s", requirement: "x" });
    await bus.emit({ type: "stage.changed", stage: "IMPLEMENTING", at: "t", note: "" });

    server = await startUIServer({
      channel,
      logger: silentLogger,
      port: 0,
      listModels: async () => [{ providerID: "xiaomi", id: "mimo-v2.6-pro", tools: true }],
    });
    const base = `http://127.0.0.1:${server.port}`;

    const status = (await (await fetch(`${base}/api/status?runId=run-s`)).json()) as {
      round: number;
    };
    expect(status.round).toBe(2);

    const chat = (await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-s", message: "hi" }),
      })
    ).json()) as { action: string };
    expect(chat.action).toBe("consult");

    const exported = (await (await fetch(`${base}/api/export?runId=run-s`)).json()) as {
      markdown: string;
    };
    expect(exported.markdown).toContain("# 导出");

    const models = (await (await fetch(`${base}/api/models`)).json()) as {
      models: Array<{ id: string }>;
    };
    expect(models.models[0]?.id).toBe("mimo-v2.6-pro");

    // SSE：since=0 补发 2 条历史
    const controller = new AbortController();
    const resp = await fetch(`${base}/api/events?runId=run-s&since=0`, {
      signal: controller.signal,
    });
    const reader = resp.body!.getReader();
    const { value } = await reader.read();
    controller.abort();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"seq":1');
    expect(text).toContain('"seq":2');
  });

  it("Bearer 令牌鉴权（§8.4）", async () => {
    store = new SqliteStore();
    const channel = new UIChannel(silentLogger);
    server = await startUIServer({
      channel,
      logger: silentLogger,
      port: 0,
      token: "secret-token",
    });
    const base = `http://127.0.0.1:${server.port}`;

    const denied = await fetch(`${base}/api/models`);
    expect(denied.status).toBe(401);

    const ok = await fetch(`${base}/api/models`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(ok.status).toBe(200);
  });
});

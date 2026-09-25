/**
 * v1.1 UI 桥接服务（P0 报告 §3）：
 * 静态托管 Web UI + SSE 事件流 + REST，全部经 UIChannel.handlers() 进入编排器
 * （与插件 RPC 共用同一实现，保证路线可切换）。
 *
 * 安全（§8.4）：默认仅绑定 127.0.0.1；设置 OPENCODE_DUAL_UI_TOKEN 后要求 Bearer 鉴权。
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../ports";
import type { ModelRef } from "../protocols/ui-event";
import type { UIChannel } from "../adapters/ui-channel-adapter";

export interface UIServerOptions {
  channel: UIChannel;
  logger: Logger;
  port?: number;
  host?: string;
  /** UI 静态资源目录（默认 ui/dist）。 */
  staticDir?: string;
  /** 模型列表（来自 OpenCode 已配置 provider）。 */
  listModels?: () => Promise<Array<{ providerID: string; id: string; name?: string; contextLength?: number; tools?: boolean }>>;
  /** 鉴权令牌（默认读环境变量 OPENCODE_DUAL_UI_TOKEN；为空则不鉴权）。 */
  token?: string | null;
}

export interface UIServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export async function startUIServer(opts: UIServerOptions): Promise<UIServer> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token === undefined ? process.env.OPENCODE_DUAL_UI_TOKEN ?? null : opts.token;
  const staticDir =
    opts.staticDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
  const handlers = opts.channel.handlers();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      opts.logger.warn({ err }, "UI 服务请求失败");
      sendJson(res, 500, { error: "internal", message: String(err) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // 鉴权（§8.4）
    if (token) {
      const auth = req.headers.authorization ?? "";
      const provided = auth === `Bearer ${token}` || url.searchParams.get("token") === token;
      if (!provided) {
        sendJson(res, 401, { error: "unauthorized", message: "缺少或错误的令牌" });
        return;
      }
    }

    // CORS（UI 开发端口）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // SSE 事件流：先按 since 补发，再实时推送（不丢不乱序）
    if (url.pathname === "/api/events") {
      const runId = url.searchParams.get("runId") ?? "";
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      let unsubscribe: (() => void) | undefined;
      if (runId) {
        try {
          const replay = (await handlers.replay!({ runId, since }, rpcCtx(res))) as {
            events: unknown[];
          };
          for (const e of replay.events) send(e);
        } catch {
          res.write(`data: ${JSON.stringify({ error: "run_not_found", runId })}\n\n`);
        }
        unsubscribe = opts.channel.subscribe(runId, (envelope) => send(envelope));
      } else {
        // 无 runId：广播订阅（UI 用于发现 run.started，随后可定向订阅）
        unsubscribe = opts.channel.subscribeAll((envelope) => send(envelope));
      }

      const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe?.();
      });
      return;
    }

    // REST
    if (url.pathname === "/api/runs" && req.method === "GET") {
      sendJson(res, 200, { runs: opts.channel.listRuns() });
      return;
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      const models = (await opts.listModels?.()) ?? [];
      sendJson(res, 200, { models });
      return;
    }

    const rest: Array<[string, string, string]> = [
      ["GET", "/api/status", "status"],
      ["POST", "/api/chat", "chat"],
      ["POST", "/api/model", "model.set"],
      ["POST", "/api/pause", "pause"],
      ["POST", "/api/resume", "resume"],
      ["GET", "/api/export", "export"],
      ["GET", "/api/events/replay", "replay"],
    ];
    for (const [method, pathname, handlerName] of rest) {
      if (url.pathname !== pathname || req.method !== method) continue;
      const body = method === "POST" ? await readJson(req) : {};
      const input: Record<string, unknown> = {
        ...body,
        runId: (body.runId as string) ?? url.searchParams.get("runId") ?? "",
      };
      if (handlerName === "events") input.since = Number(url.searchParams.get("since") ?? "0") || 0;
      if (handlerName === "export") {
        const result = (await handlers.export!(input, rpcCtx(res))) as { markdown: string };
        sendJson(res, 200, result);
        return;
      }
      const result = await handlers[handlerName]!(input, rpcCtx(res));
      sendJson(res, 200, result);
      return;
    }

    // 静态 UI
    serveStatic(res, staticDir, url.pathname);
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port ?? 4700, host);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 4700);
  opts.logger.info({ host, port }, "v1.1 UI 桥接服务已启动");

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function rpcCtx(res: http.ServerResponse): {
  error(type: string, message: string, data?: unknown): never;
  signal?: AbortSignal;
} {
  return {
    error(type: string, message: string, data?: unknown): never {
      sendJson(res, 400, { error: type, message, data });
      throw new Error(`${type}: ${message}`);
    },
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function serveStatic(res: http.ServerResponse, staticDir: string, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(staticDir, rel);
  if (!file.startsWith(path.resolve(staticDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(staticDir, "index.html");
    if (fs.existsSync(index)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(index));
      return;
    }
    // 未构建 UI 时的内置占位页
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>dual-agent UI</title>
       <p>UI 尚未构建：在 <code>ui/</code> 目录执行 <code>npm install &amp;&amp; npm run build</code> 后刷新本页。</p>
       <p>API 可用：<code>/api/status?runId=</code>、<code>/api/events?runId=&amp;since=</code>（SSE）。</p>`,
    );
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
}

export type { ModelRef };

/**
 * 进程级共享单例（v1.1 修复）：
 * 插件按位置（location）加载会产生多个插件实例（各自独立的模块注册表），
 * UI 通道与 UI 服务必须经 globalThis 全局共享，否则运行会注册进没持有端口的实例。
 */
import type { Logger } from "../ports";
import type { ModelRef } from "../protocols/ui-event";
import { UIChannel } from "../adapters/ui-channel-adapter";
import { startUIServer, type UIServer } from "./server";

interface SharedState {
  channel?: UIChannel;
  server?: UIServer;
  serverStarting?: Promise<UIServer | undefined>;
}

const globalKey = Symbol.for("opencode-dual-agent.ui-state");

function sharedState(): SharedState {
  const g = globalThis as Record<symbol, SharedState | undefined>;
  if (!g[globalKey]) g[globalKey] = {};
  return g[globalKey]!;
}

export function sharedUIChannel(logger: Logger): UIChannel {
  const state = sharedState();
  if (!state.channel) state.channel = new UIChannel(logger);
  return state.channel;
}

export interface EnsureUIServerOptions {
  logger: Logger;
  port?: number;
  host?: string;
  token?: string | null;
  listModels?: () => Promise<
    Array<{ providerID: string; id: string; name?: string; contextLength?: number; tools?: boolean }>
  >;
}

/** 全局仅启动一个 UI 服务；并发调用合并。绑定失败返回 undefined（不影响命令）。 */
export async function ensureUIServer(opts: EnsureUIServerOptions): Promise<UIServer | undefined> {
  const state = sharedState();
  if (state.server) return state.server;
  if (state.serverStarting) return state.serverStarting;

  state.serverStarting = (async () => {
    try {
      state.server = await startUIServer({
        channel: sharedUIChannel(opts.logger),
        logger: opts.logger,
        port: opts.port,
        host: opts.host,
        token: opts.token,
        listModels: opts.listModels,
      });
      return state.server;
    } catch (err) {
      opts.logger.warn(
        { err, port: opts.port ?? 4700 },
        "UI 桥接服务启动失败（可能已有实例运行），仅禁用 UI，命令不受影响",
      );
      return undefined;
    } finally {
      state.serverStarting = undefined;
    }
  })();
  return state.serverStarting;
}

export type { UIServer, ModelRef };

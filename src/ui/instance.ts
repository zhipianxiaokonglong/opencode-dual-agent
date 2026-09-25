/**
 * 进程级共享单例（v1.1 修复）：
 * 插件按位置（location）加载会产生多个插件实例，但 UI 通道与 UI 服务必须全局唯一，
 * 否则运行会注册进没持有端口的实例，UI 无法发现运行。
 */
import type { Logger } from "../ports";
import type { ModelRef } from "../protocols/ui-event";
import { UIChannel } from "../adapters/ui-channel-adapter";
import { startUIServer, type UIServer } from "./server";

let sharedChannel: UIChannel | undefined;
let sharedServer: UIServer | undefined;

export function sharedUIChannel(logger: Logger): UIChannel {
  if (!sharedChannel) sharedChannel = new UIChannel(logger);
  return sharedChannel;
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

/** 全局仅启动一个 UI 服务；后续调用返回同一实例。绑定失败返回 undefined（不影响命令）。 */
export async function ensureUIServer(opts: EnsureUIServerOptions): Promise<UIServer | undefined> {
  if (sharedServer) return sharedServer;
  try {
    sharedServer = await startUIServer({
      channel: sharedUIChannel(opts.logger),
      logger: opts.logger,
      port: opts.port,
      host: opts.host,
      token: opts.token,
      listModels: opts.listModels,
    });
    return sharedServer;
  } catch (err) {
    opts.logger.warn(
      { err, port: opts.port ?? 4700 },
      "UI 桥接服务启动失败（可能已有实例运行），仅禁用 UI，命令不受影响",
    );
    return undefined;
  }
}

export type { UIServer, ModelRef };

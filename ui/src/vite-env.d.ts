/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 桥接服务地址（默认 http://127.0.0.1:4700）。 */
  readonly VITE_BRIDGE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

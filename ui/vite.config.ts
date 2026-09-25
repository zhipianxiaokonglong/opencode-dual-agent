import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 桥接服务 CORS 仅放行 http://127.0.0.1:5173（契约 §传输），故开发端口固定。
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});

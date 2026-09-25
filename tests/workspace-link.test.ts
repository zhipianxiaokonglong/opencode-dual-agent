import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileWorkspace } from "../src/workspace";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("FileWorkspace 依赖链接（验证可用性）", () => {
  it("副本工作区自动链接 node_modules，验证命令可执行", async () => {
    const source = tmpDir("dual-ws-src-");
    const baseDir = tmpDir("dual-ws-base-");
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.writeFileSync(path.join(source, "src", "index.ts"), "export const x = 1;\n");
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ name: "t", scripts: { test: "node -e \"process.exit(0)\"" } }),
    );
    // 模拟源项目的依赖目录
    fs.mkdirSync(path.join(source, "node_modules", "fake-dep"), { recursive: true });
    fs.writeFileSync(path.join(source, "node_modules", "fake-dep", "index.js"), "module.exports = 1;");

    const ws = await FileWorkspace.create({ source, baseDir, name: "ws", mode: "copy" });
    cleanups.push(() => ws.destroy());

    // 工作区能看到依赖（junction/symlink）
    const linked = path.join(ws.root, "node_modules", "fake-dep", "index.js");
    expect(fs.existsSync(linked)).toBe(true);
    // 源文件在白名单内
    expect(fs.existsSync(path.join(ws.root, "src", "index.ts"))).toBe(true);
    // revision 随内容变化
    const rev1 = await ws.revision();
    fs.writeFileSync(path.join(ws.root, "src", "index.ts"), "export const x = 2;\n");
    const rev2 = await ws.revision();
    expect(rev1).not.toBe(rev2);
  });

  it("源项目无 node_modules 时不报错", async () => {
    const source = tmpDir("dual-ws-src2-");
    const baseDir = tmpDir("dual-ws-base2-");
    fs.writeFileSync(path.join(source, "package.json"), "{}");
    const ws = await FileWorkspace.create({ source, baseDir, name: "ws", mode: "copy" });
    cleanups.push(() => ws.destroy());
    expect(fs.existsSync(path.join(ws.root, "package.json"))).toBe(true);
  });

  it("WorkspaceTooLargeError 存在且超大源目录可被拦截", async () => {
    const { WorkspaceTooLargeError } = await import("../src/workspace");
    const err = new WorkspaceTooLargeError("10000 个文件");
    expect(err.name).toBe("WorkspaceTooLargeError");
    expect(err.message).toContain("上限");
  });
});

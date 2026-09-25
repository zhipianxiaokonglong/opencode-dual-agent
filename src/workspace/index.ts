/**
 * 隔离工作区（§3.1 / §8.1）：
 * Git worktree 优先，非 Git 仓库退化为副本。
 * 注意：worktree 仅隔离文件，不隔离运行时；运行时隔离由容器层负责（P3）。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { RepoMaterials, Workspace } from "../ports";

export interface WorkspaceCreateOptions {
  /** 源项目目录。 */
  source: string;
  /** 工作区存放根目录。 */
  baseDir: string;
  /** worktree | copy */
  mode?: "worktree" | "copy";
  name?: string;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".opencode"]);

export class FileWorkspace implements Workspace {
  private constructor(
    readonly root: string,
    private readonly cleanup: () => Promise<void>,
    private readonly source: string,
  ) {}

  static async create(opts: WorkspaceCreateOptions): Promise<FileWorkspace> {
    const mode = opts.mode ?? (await isGitRepo(opts.source) ? "worktree" : "copy");
    const name = opts.name ?? `ws-${Date.now().toString(36)}`;
    const root = path.resolve(opts.baseDir, name);
    await fs.mkdir(path.dirname(root), { recursive: true });

    if (mode === "worktree") {
      await run("git", ["worktree", "add", "--detach", root], opts.source);
      return new FileWorkspace(
        root,
        async () => {
          await run("git", ["worktree", "remove", "--force", root], opts.source).catch(() => {});
          await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        },
        opts.source,
      );
    }

    await copyTree(opts.source, root);
    return new FileWorkspace(root, () => fs.rm(root, { recursive: true, force: true }), opts.source);
  }

  /** 当前修订号：git HEAD + 工作区差异哈希；使测试结果与代码版本强绑定。 */
  async revision(): Promise<string> {
    if (await isGitRepo(this.root)) {
      const head = (await run("git", ["rev-parse", "HEAD"], this.root)).stdout.trim();
      const status = (await run("git", ["status", "--porcelain"], this.root)).stdout.trim();
      const diff = await this.diff().catch(() => "");
      const h = createHash("sha256").update(status).update(diff).digest("hex").slice(0, 12);
      return `${head.slice(0, 12)}-dirty-${h}`;
    }
    // 非 Git：按文件树内容哈希
    const files = await listFiles(this.root, 4000);
    const hash = createHash("sha256");
    for (const rel of files) {
      hash.update(rel);
      const stat = await fs.stat(path.join(this.root, rel));
      hash.update(String(stat.size));
      hash.update(String(stat.mtimeMs));
    }
    return `tree-${hash.digest("hex").slice(0, 16)}`;
  }

  async diff(): Promise<string> {
    if (!(await isGitRepo(this.root))) return "";
    const tracked = await run("git", ["diff", "HEAD"], this.root).catch(() => ({ stdout: "", stderr: "", code: 0 }));
    const untracked = await run(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      this.root,
    ).catch(() => ({ stdout: "", stderr: "", code: 0 }));
    let out = tracked.stdout;
    for (const file of untracked.stdout.split("\n").filter(Boolean)) {
      const content = await fs.readFile(path.join(this.root, file), "utf8").catch(() => "");
      out += `\n--- /dev/null\n+++ b/${file}\n${content
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n")}`;
    }
    return out;
  }

  async changedFiles(): Promise<string[]> {
    if (!(await isGitRepo(this.root))) return [];
    const out = await run("git", ["status", "--porcelain"], this.root);
    return out.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim().replace(/"/g, ""))
      .map((p) => p.replace(/\\/g, "/"));
  }

  /** 仓库材料（供 ANALYZING 使用）：目录树、依赖、测试目录、约定。 */
  async materials(): Promise<RepoMaterials> {
    const tree = (await listFiles(this.root, 800)).map((p) => p.replace(/\\/g, "/"));
    let packageJson: RepoMaterials["packageJson"];
    try {
      const raw = await fs.readFile(path.join(this.root, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      packageJson = {
        name: typeof parsed.name === "string" ? parsed.name : undefined,
        scripts: (parsed.scripts as Record<string, string>) ?? {},
        dependencies: (parsed.dependencies as Record<string, string>) ?? {},
        devDependencies: (parsed.devDependencies as Record<string, string>) ?? {},
      };
    } catch {
      packageJson = undefined;
    }
    const testDirs = tree
      .filter((p) => /(^|\/)(tests?|__tests__)(\/|$)/.test(p) || /\.(test|spec)\.[jt]sx?$/.test(p))
      .slice(0, 40);
    const conventions: string[] = [];
    for (const doc of ["README.md", "CONTRIBUTING.md", "AGENTS.md", ".editorconfig"]) {
      const content = await fs.readFile(path.join(this.root, doc), "utf8").catch(() => "");
      if (content) conventions.push(`# ${doc}\n${content.slice(0, 1500)}`);
    }
    return { root: this.root, tree: tree.slice(0, 400), packageJson, testDirs, conventions };
  }

  async destroy(): Promise<void> {
    await this.cleanup();
  }
}

// ---------------------------------------------------------------------------

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function copyTree(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

async function listFiles(root: string, limit: number, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...(await listFiles(root, limit - out.length, path.join(prefix, entry.name))));
    } else if (entry.isFile()) {
      out.push(path.join(prefix, entry.name));
    }
  }
  return out;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(
  bin: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 60_000,
  env?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd,
      shell: false, // 永远不经过 shell（§8.2）
      env: env ?? process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`命令超时: ${bin} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

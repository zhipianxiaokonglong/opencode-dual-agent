/**
 * 测试执行器（§3.2 verification/）：
 * - 只执行受控检查命令（固定配置数组），不执行模型输出的任意 shell 字符串
 * - 输出结构化测试报告并绑定代码 revision（§5.2 关键规则）
 * - 日志落盘为可追溯产物
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoMaterials, Verifier, VerifierInput } from "../ports";
import {
  TestReportSchema,
  type FailedTest,
  type TestReport,
} from "../protocols";
import { assertSafeCommand, sanitizedEnv } from "../security/permissions";

// ---------------------------------------------------------------------------
// 受控执行
// ---------------------------------------------------------------------------

export interface ExecRequest {
  command: readonly string[];
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ExecRunner = (req: ExecRequest) => Promise<ExecResult>;

/** 直接 spawn（不经 shell）；Windows 下 .cmd 需经 cmd.exe，命令已由 assertSafeCommand 消毒。 */
export const defaultExecRunner: ExecRunner = (req) => {
  assertSafeCommand({ command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs });
  const { file, args } = buildSpawnCommand(req.command);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: req.cwd,
      env: req.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, req.timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    req.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
};

function buildSpawnCommand(command: readonly string[]): { file: string; args: string[] } {
  const [bin, ...rest] = command;
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    const quoted = command.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ");
    return { file: comspec, args: ["/d", "/s", "/c", quoted] };
  }
  return { file: bin as string, args: [...rest] };
}

// ---------------------------------------------------------------------------
// 检查配置（verification profile）
// ---------------------------------------------------------------------------

export interface CheckTemplate {
  id: string;
  description: string;
  npmScript: string;
  /** 脚本缺失时的兜底命令（无则标记 not_run）。 */
  fallback?: string[];
  timeoutMs: number;
}

export const VERIFICATION_PROFILES: Record<string, CheckTemplate[]> = {
  backend: [
    { id: "typecheck", description: "TypeScript 类型检查", npmScript: "typecheck", fallback: ["npx", "tsc", "--noEmit"], timeoutMs: 180_000 },
    { id: "lint", description: "静态分析", npmScript: "lint", timeoutMs: 180_000 },
    { id: "test", description: "单元/集成测试", npmScript: "test", fallback: ["npm", "test"], timeoutMs: 600_000 },
    { id: "build", description: "构建", npmScript: "build", timeoutMs: 600_000 },
  ],
  frontend: [
    { id: "typecheck", description: "TypeScript 类型检查", npmScript: "typecheck", fallback: ["npx", "tsc", "--noEmit"], timeoutMs: 180_000 },
    { id: "lint", description: "静态分析", npmScript: "lint", timeoutMs: 180_000 },
    { id: "test", description: "单元测试", npmScript: "test", fallback: ["npm", "test"], timeoutMs: 600_000 },
    { id: "build", description: "生产构建", npmScript: "build", timeoutMs: 600_000 },
  ],
  library: [
    { id: "typecheck", description: "TypeScript 类型检查", npmScript: "typecheck", fallback: ["npx", "tsc", "--noEmit"], timeoutMs: 180_000 },
    { id: "test", description: "单元测试", npmScript: "test", fallback: ["npm", "test"], timeoutMs: 600_000 },
    { id: "build", description: "构建", npmScript: "build", timeoutMs: 600_000 },
  ],
  none: [],
};

export interface ResolvedCheck {
  id: string;
  description: string;
  command: string[] | null;
  timeoutMs: number;
  skipReason?: string;
}

export function resolveChecks(profile: string, materials: Pick<RepoMaterials, "packageJson">): ResolvedCheck[] {
  const templates = VERIFICATION_PROFILES[profile];
  if (!templates) throw new Error(`未知 verificationProfile: ${profile}`);
  const scripts = materials.packageJson?.scripts ?? {};
  return templates.map((t) => {
    if (scripts[t.npmScript] !== undefined) {
      return {
        id: t.id,
        description: t.description,
        command: ["npm", "run", t.npmScript],
        timeoutMs: t.timeoutMs,
      };
    }
    if (t.fallback) {
      return { id: t.id, description: t.description, command: [...t.fallback], timeoutMs: t.timeoutMs };
    }
    return {
      id: t.id,
      description: t.description,
      command: null,
      timeoutMs: t.timeoutMs,
      skipReason: `package.json 中缺少 scripts.${t.npmScript}`,
    };
  });
}

// ---------------------------------------------------------------------------
// LocalVerifier
// ---------------------------------------------------------------------------

export interface LocalVerifierOptions {
  artifactsDir: string;
  exec?: ExecRunner;
  env?: Record<string, string>;
  /** 自定义检查集（覆盖 profile）；用于非 npm 项目或演示。 */
  checks?: CheckTemplate[];
}

export class LocalVerifier implements Verifier {
  constructor(private readonly opts: LocalVerifierOptions) {}

  async run(input: VerifierInput): Promise<TestReport[]> {
    const materials = await input.workspace.materials();
    const checks = this.opts.checks
      ? this.opts.checks.map((t) =>
          materials.packageJson?.scripts?.[t.npmScript] !== undefined
            ? { id: t.id, description: t.description, command: ["npm", "run", t.npmScript], timeoutMs: t.timeoutMs }
            : {
                id: t.id,
                description: t.description,
                command: t.fallback ? [...t.fallback] : null,
                timeoutMs: t.timeoutMs,
                skipReason: t.fallback ? undefined : `package.json 中缺少 scripts.${t.npmScript}`,
              },
        )
      : resolveChecks(input.profile, materials);
    const reports: TestReport[] = [];

    for (const check of checks) {
      if (!check.command) {
        reports.push(
          TestReportSchema.parse({
            checkId: check.id,
            revision: input.revision,
            profile: input.profile,
            status: "not_run",
            exitCode: null,
            failedTests: [],
            logArtifact: null,
            durationMs: 0,
          }),
        );
        continue;
      }

      assertSafeCommand({
        command: check.command,
        cwd: input.workspace.root,
        timeoutMs: check.timeoutMs,
      });

      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let status: TestReport["status"] = "passed";
      try {
        const result = await (this.opts.exec ?? defaultExecRunner)({
          command: check.command,
          cwd: input.workspace.root,
          timeoutMs: check.timeoutMs,
          env: this.opts.env ?? sanitizedEnv(),
          signal: input.signal,
        });
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
        status = result.timedOut ? "error" : result.exitCode === 0 ? "passed" : "failed";
        if (result.timedOut) stderr += `\n[timeout after ${check.timeoutMs}ms]`;
      } catch (err) {
        status = "error";
        stderr = err instanceof Error ? err.message : String(err);
      }

      const logArtifact = this.writeArtifact(input, check.id, stdout, stderr);
      reports.push(
        TestReportSchema.parse({
          checkId: check.id,
          revision: input.revision,
          profile: input.profile,
          status,
          exitCode,
          failedTests: status === "passed" ? [] : parseFailedTests(`${stdout}\n${stderr}`),
          logArtifact,
          durationMs: Date.now() - startedAt,
        }),
      );
    }

    return reports;
  }

  private writeArtifact(
    input: VerifierInput,
    checkId: string,
    stdout: string,
    stderr: string,
  ): string {
    const dir = this.opts.artifactsDir;
    fs.mkdirSync(dir, { recursive: true });
    const name = `${checkId}-${sanitizeRevision(input.revision)}.log`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(
      filePath,
      `# check: ${checkId}\n# revision: ${input.revision}\n# profile: ${input.profile}\n\n=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}\n`,
      "utf8",
    );
    return name;
  }
}

function sanitizeRevision(revision: string): string {
  return revision.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// 失败用例解析（vitest / jest 风格输出）
// ---------------------------------------------------------------------------

const FAIL_LINE_RE = /^\s*[×✕✗✖x]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/;
const JEST_FAIL_RE = /^\s*●\s+(.+?)\s*$/;

export function parseFailedTests(output: string, limit = 20): FailedTest[] {
  const lines = output.split("\n");
  const out: FailedTest[] = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i] ?? "";
    const match = FAIL_LINE_RE.exec(line) ?? JEST_FAIL_RE.exec(line);
    if (!match) continue;
    const name = (match[1] ?? "").trim();
    if (!name || name.startsWith("Console")) continue;
    let summary = "";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const next = lines[j] ?? "";
      if (/Error|expect|Assertion|Received|Expected/i.test(next)) {
        summary = next.trim().slice(0, 200);
        break;
      }
    }
    out.push({ name: name.slice(0, 300), summary });
  }
  return out;
}

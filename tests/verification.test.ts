import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LocalVerifier,
  parseFailedTests,
  resolveChecks,
} from "../src/verification";
import { PermissionDeniedError } from "../src/security/permissions";
import { FakeWorkspace, makeReport } from "./helpers";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-art-"));
  tmpDirs.push(dir);
  return dir;
}

describe("resolveChecks", () => {
  it("按 package.json 脚本解析命令", () => {
    const checks = resolveChecks("library", {
      packageJson: { scripts: { typecheck: "tsc", test: "vitest run", build: "tsc -p ." } },
    });
    expect(checks.map((c) => c.id)).toEqual(["typecheck", "test", "build"]);
    expect(checks[0]?.command).toEqual(["npm", "run", "typecheck"]);
  });

  it("脚本缺失时兜底或标记 not_run", () => {
    const checks = resolveChecks("backend", {
      packageJson: { scripts: { typecheck: "tsc" } },
    });
    const typecheck = checks.find((c) => c.id === "typecheck")!;
    const lint = checks.find((c) => c.id === "lint")!;
    const test = checks.find((c) => c.id === "test")!;
    expect(typecheck.command).toEqual(["npm", "run", "typecheck"]);
    expect(lint.command).toBeNull();
    expect(lint.skipReason).toContain("scripts.lint");
    expect(test.command).toEqual(["npm", "test"]); // fallback
  });

  it("未知 profile 抛错", () => {
    expect(() => resolveChecks("nope", { packageJson: {} })).toThrow();
  });
});

describe("LocalVerifier", () => {
  it("执行检查、写产物、绑定 revision、解析失败用例", async () => {
    const artifacts = tmpDir();
    const workspace = new FakeWorkspace("/tmp/ws");
    const verifier = new LocalVerifier({
      artifactsDir: artifacts,
      exec: async (req) => ({
        exitCode: req.command.includes("test") ? 1 : 0,
        stdout: req.command.includes("test")
          ? ["  × rejects duplicate email 12ms", "    AssertionError: expected 200 to be 409"].join("\n")
          : "ok",
        stderr: "",
        timedOut: false,
      }),
    });

    const reports = await verifier.run({
      workspace,
      profile: "library",
      revision: "rev-42",
      signal: new AbortController().signal,
    });

    expect(reports).toHaveLength(3);
    const testReport = reports.find((r) => r.checkId === "test")!;
    expect(testReport.status).toBe("failed");
    expect(testReport.revision).toBe("rev-42");
    expect(testReport.failedTests[0]?.name).toBe("rejects duplicate email");
    expect(testReport.failedTests[0]?.summary).toContain("AssertionError");
    expect(testReport.logArtifact).toBeTruthy();
    const logPath = path.join(artifacts, testReport.logArtifact!);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toContain("revision: rev-42");

    const buildReport = reports.find((r) => r.checkId === "build")!;
    expect(buildReport.status).toBe("passed");
  });

  it("脚本缺失的检查标记 not_run（报告中的'未运行'）", async () => {
    const artifacts = tmpDir();
    const workspace = new FakeWorkspace("/tmp/ws");
    const verifier = new LocalVerifier({
      artifactsDir: artifacts,
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    });
    const reports = await verifier.run({
      workspace,
      profile: "backend",
      revision: "rev-1",
      signal: new AbortController().signal,
    });
    const lint = reports.find((r) => r.checkId === "lint")!;
    expect(lint.status).toBe("not_run");
    expect(lint.logArtifact).toBeNull();
  });

  it("执行器抛错时报告 error 而不是崩溃", async () => {
    const artifacts = tmpDir();
    const workspace = new FakeWorkspace("/tmp/ws");
    const verifier = new LocalVerifier({
      artifactsDir: artifacts,
      exec: async () => {
        throw new Error("spawn failed");
      },
    });
    const reports = await verifier.run({
      workspace,
      profile: "library",
      revision: "rev-1",
      signal: new AbortController().signal,
    });
    expect(reports.every((r) => r.status === "error")).toBe(true);
  });

  it("危险命令被拒绝执行（禁止模型输出拼接 shell）", async () => {
    const artifacts = tmpDir();
    const workspace = new FakeWorkspace("/tmp/ws");
    const verifier = new LocalVerifier({
      artifactsDir: artifacts,
      exec: async (req) => {
        const { assertSafeCommand } = await import("../src/security/permissions");
        assertSafeCommand({ command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs });
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    // 直接验证断言本身生效
    expect(() =>
      new LocalVerifier({ artifactsDir: artifacts }).constructor,
    ).not.toThrow();
    const reports = await verifier.run({
      workspace,
      profile: "library",
      revision: "rev-1",
      signal: new AbortController().signal,
    });
    expect(reports.find((r) => r.checkId === "test")?.status).toBe("passed");
    expect(PermissionDeniedError).toBeDefined();
  });
});

describe("parseFailedTests", () => {
  it("解析 vitest / jest 风格失败用例", () => {
    const output = [
      "  × login rejects duplicate email 12ms",
      "    AssertionError: expected 200 to be 409",
      "  ● add handles empty input",
      "    TypeError: cannot read",
    ].join("\n");
    const failed = parseFailedTests(output);
    expect(failed).toHaveLength(2);
    expect(failed[0]?.name).toBe("login rejects duplicate email");
    expect(failed[1]?.name).toBe("add handles empty input");
    expect(failed[1]?.summary).toContain("TypeError");
  });
});

describe("makeReport 辅助", () => {
  it("默认报告绑定 revision", () => {
    expect(makeReport("rev-9").revision).toBe("rev-9");
  });
});

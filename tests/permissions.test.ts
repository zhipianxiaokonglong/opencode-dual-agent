import { describe, expect, it } from "vitest";
import {
  PathGuard,
  PermissionDeniedError,
  assertSafeCommand,
  detectTestTampering,
  isSensitivePath,
  matchesGlob,
  sanitizedEnv,
} from "../src/security/permissions";

describe("路径白名单（§8.2）", () => {
  const guard = new PathGuard({
    allowedPaths: ["src/**", "tests/auth/**"],
    workspaceRoot: "/ws",
  });

  it("白名单内放行", () => {
    expect(guard.assertAllowed("src/index.ts")).toBe("src/index.ts");
    expect(guard.assertAllowed("tests/auth/login.test.ts")).toBe("tests/auth/login.test.ts");
  });

  it("白名单外拒绝", () => {
    expect(() => guard.assertAllowed("docs/readme.md")).toThrow(PermissionDeniedError);
    expect(() => guard.assertAllowed("tests/admin/a.test.ts")).toThrow(PermissionDeniedError);
  });

  it("越界拒绝", () => {
    expect(() => guard.assertAllowed("../outside.txt")).toThrow(PermissionDeniedError);
    expect(() => guard.assertAllowed("src/../../etc/passwd")).toThrow(PermissionDeniedError);
  });

  it("敏感文件拒绝", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.local")).toBe(true);
    expect(isSensitivePath("secrets/key.pem")).toBe(true);
    expect(() => guard.assertAllowed("src/.env")).toThrow(PermissionDeniedError);
    const loose = new PathGuard({ allowedPaths: ["**"], workspaceRoot: "/ws" });
    expect(() => loose.assertAllowed(".env")).toThrow(PermissionDeniedError);
    expect(() => loose.assertAllowed("a/b/id_rsa")).toThrow(PermissionDeniedError);
  });

  it("glob 匹配语义", () => {
    expect(matchesGlob("src/a/b.ts", "src/**")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("tests/auth/x.ts", "tests/**")).toBe(true);
    expect(matchesGlob("xsrc/a.ts", "src/**")).toBe(false);
  });
});

describe("shell 安全（§8.2 禁止模型输出拼接 shell）", () => {
  it("数组形式命令放行", () => {
    expect(() =>
      assertSafeCommand({ command: ["npm", "run", "test"], cwd: "/ws", timeoutMs: 1000 }),
    ).not.toThrow();
  });

  it("shell 元字符拒绝", () => {
    for (const bad of ["rm -rf /; echo hi", "a$(whoami)", "a|b", "a`b`", "a&&b", 'a"b', "a>b"]) {
      expect(() =>
        assertSafeCommand({ command: ["npm", bad], cwd: "/ws", timeoutMs: 1000 }),
      ).toThrow(PermissionDeniedError);
    }
    expect(() =>
      assertSafeCommand({ command: [], cwd: "/ws", timeoutMs: 1000 }),
    ).toThrow(PermissionDeniedError);
  });

  it("执行环境脱敏：凭证类变量不透传", () => {
    const env = sanitizedEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      NPM_CONFIG_PASSWORD: "secret",
      MY_API_KEY: "secret",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NPM_CONFIG_PASSWORD).toBeUndefined();
    expect(env.MY_API_KEY).toBeUndefined();
  });
});

describe("防改测试作弊（§8.3）", () => {
  it("标记删除测试用例", () => {
    const diff = [
      "--- a/tests/login.test.ts",
      "+++ b/tests/login.test.ts",
      "-describe('login', () => {",
      "-  it('rejects duplicate email', () => {",
      "+describe('login', () => {",
    ].join("\n");
    const findings = detectTestTampering(diff);
    expect(findings.some((f) => f.kind === "test-cases-removed")).toBe(true);
  });

  it("标记新增 skip 与修改断言", () => {
    const diff = [
      "--- a/tests/login.test.ts",
      "+++ b/tests/login.test.ts",
      "+  it.skip('rejects duplicate email', () => {",
      "-    expect(res.status).toBe(409);",
      "+    expect(res.status).toBe(200);",
    ].join("\n");
    const findings = detectTestTampering(diff);
    expect(findings.some((f) => f.kind === "test-skips-added")).toBe(true);
    expect(findings.some((f) => f.kind === "assertions-changed")).toBe(true);
  });

  it("非测试文件不误报", () => {
    const diff = ["--- a/src/index.ts", "+++ b/src/index.ts", "-expect(x).toBe(1);", "+expect(x).toBe(2);"].join(
      "\n",
    );
    expect(detectTestTampering(diff)).toHaveLength(0);
  });
});

/**
 * 权限执行层（§8）：不能仅靠提示词限制模型行为。
 * - 路径白名单 / 敏感文件黑名单
 * - 禁止把模型输出直接拼接 shell（命令只允许数组形式）
 * - 防"改测试作弊"：差异显式标记
 */
import * as path from "node:path";

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/** 敏感文件黑名单（相对工作区根的路径匹配）。 */
export const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.git\/(config|credentials)/,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx|crt|cer)$/i,
  /(^|\/)(credentials|secrets?)(\.|\/|$)/i,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)auth\.json$/i,
];

export function isSensitivePath(relPath: string): boolean {
  const normalized = toPosix(relPath);
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(normalized));
}

/** 白名单 glob 匹配：支持 `*`（单段）与 `**`（任意层）。 */
export function matchesGlob(relPath: string, pattern: string): boolean {
  const regex = globToRegExp(pattern);
  return regex.test(toPosix(relPath));
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern);
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // `**/` 匹配任意层目录（含零层）
        if (normalized[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch!)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out);
}

export interface PathGuardOptions {
  /** 白名单（glob，相对工作区根）。 */
  allowedPaths: readonly string[];
  workspaceRoot: string;
  /** 附加黑名单（默认含敏感文件）。 */
  extraDenied?: readonly string[];
}

/**
 * 路径守卫：所有写操作必须通过它。
 * - 越界（逃出工作区）拒绝
 * - 敏感文件拒绝
 * - 白名单外路径拒绝
 */
export class PathGuard {
  constructor(private readonly opts: PathGuardOptions) {}

  assertAllowed(targetPath: string, action = "write"): string {
    const root = path.resolve(this.opts.workspaceRoot);
    const resolved = path.resolve(root, targetPath);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PermissionDeniedError(`越界访问被拒绝: ${targetPath}`);
    }
    const relPosix = toPosix(rel);
    if (isSensitivePath(relPosix)) {
      throw new PermissionDeniedError(`敏感文件访问被拒绝: ${relPosix}`);
    }
    for (const denied of this.opts.extraDenied ?? []) {
      if (matchesGlob(relPosix, denied)) {
        throw new PermissionDeniedError(`命中黑名单被拒绝: ${relPosix}`);
      }
    }
    const allowed = this.opts.allowedPaths.some((p) => matchesGlob(relPosix, p));
    if (!allowed) {
      throw new PermissionDeniedError(`白名单外${action}被拒绝: ${relPosix}`);
    }
    return relPosix;
  }

  isAllowed(targetPath: string): boolean {
    try {
      this.assertAllowed(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Shell 安全：命令只接受数组形式，禁止任何 shell 元字符拼接。
 * 执行层必须 shell:false 直接 spawn。
 */
const SHELL_META_RE = /[;&|`$><\n\r"']/;

export interface CommandSpec {
  /** [可执行文件, ...参数]，禁止包含 shell 元字符。 */
  command: readonly string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export function assertSafeCommand(spec: CommandSpec): void {
  if (!spec.command.length) throw new PermissionDeniedError("空命令被拒绝");
  for (const part of spec.command) {
    if (typeof part !== "string") throw new PermissionDeniedError("命令参数必须是字符串");
    if (SHELL_META_RE.test(part)) {
      throw new PermissionDeniedError(`命令包含 shell 元字符被拒绝: ${part}`);
    }
  }
}

/** 执行环境脱敏：凭证类环境变量不传入测试/构建执行环境（§8.1 不挂载生产凭证）。 */
const CREDENTIAL_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|PRIVATE_KEY|AUTH)/i;

export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (CREDENTIAL_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 防"改测试作弊"（§8.3）
// ---------------------------------------------------------------------------

export type TamperKind =
  | "test-file-deleted"
  | "test-cases-removed"
  | "test-skips-added"
  | "assertions-changed";

export interface TamperFinding {
  kind: TamperKind;
  file: string;
  detail: string;
}

const TEST_FILE_RE = /(\.test\.|\.spec\.|__tests__\/|tests?\/)/i;
const TEST_DECL_RE = /^\s*[-]\s*.*\b(describe|it|test)\s*\(/;
const TEST_DECL_ADDED_RE = /^\s*[+]\s*.*\b(describe|it|test)\s*\(/;
const SKIP_ADDED_RE = /^\s*[+]\s*.*\.(skip|todo|only)\s*\(/;
const ASSERT_RE = /\bexpect\s*\(/;

/**
 * 扫描 diff，标记可疑的测试修改（删除测试、增加 skip、修改断言）。
 * 标记结果需显式给出理由并走审批，不得静默通过。
 */
export function detectTestTampering(diff: string, changedFiles: readonly string[] = []): TamperFinding[] {
  const findings: TamperFinding[] = [];
  let currentFile = "";

  for (const line of diff.split("\n")) {
    const fileMatch = /^[-+]{3} [ab]\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = toPosix(fileMatch[1] ?? "");
      continue;
    }
    if (!TEST_FILE_RE.test(currentFile)) continue;

    if (TEST_DECL_RE.test(line)) {
      // 删除的测试声明；若没有对应的新增声明视为移除（粗粒度，后续行再补 +）
      findings.push({ kind: "test-cases-removed", file: currentFile, detail: line.trim().slice(0, 160) });
    }
    if (SKIP_ADDED_RE.test(line)) {
      findings.push({ kind: "test-skips-added", file: currentFile, detail: line.trim().slice(0, 160) });
    }
    if (line.startsWith("-") && ASSERT_RE.test(line)) {
      findings.push({ kind: "assertions-changed", file: currentFile, detail: line.trim().slice(0, 160) });
    }
    void TEST_DECL_ADDED_RE;
  }

  for (const file of changedFiles) {
    const rel = toPosix(file);
    if (TEST_FILE_RE.test(rel) && rel.endsWith(".deleted")) {
      findings.push({ kind: "test-file-deleted", file: rel, detail: "测试文件被删除" });
    }
  }

  return dedupeTamper(findings);
}

function dedupeTamper(findings: TamperFinding[]): TamperFinding[] {
  const seen = new Set<string>();
  const out: TamperFinding[] = [];
  for (const f of findings) {
    const key = `${f.kind}|${f.file}|${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 「过程展示脱敏」（v1.1 §8.1）：过程流与导出报告中遮蔽疑似密钥/凭证。 */

const SECRET_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, kind: "github-token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, kind: "github-token" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, kind: "api-key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: "aws-key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, kind: "slack-token" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, kind: "jwt" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, kind: "private-key" },
  {
    re: /\b((?:api[_-]?key|secret|token|password|passwd|credential|authorization|bearer)\s*[:=]\s*)["']?[^\s"'，,;]{8,}["']?/gi,
    kind: "credential",
  },
];

/** 高熵字符串判定（Shannon 熵），长度 ≥ 20 的 base64/hex 形态视为疑似密钥。 */
export function entropyOf(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function isSecretLike(token: string): boolean {
  if (token.length < 20) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return false;
  return entropyOf(token) >= 4.0;
}

/** 脱敏：正则 + 熵检测。返回脱敏后的文本。 */
export function redactText(text: string): string {
  let out = text;
  for (const { re, kind } of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}[REDACTED:${kind}]` : `[REDACTED:${kind}]`,
    );
  }
  // 熵检测兜底：对长 token 做检查
  out = out.replace(/\b[A-Za-z0-9+/=_-]{20,}\b/g, (token) =>
    isSecretLike(token) ? "[REDACTED:entropy]" : token,
  );
  return out;
}

/** 结构化脱敏：递归处理对象中的字符串值。 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

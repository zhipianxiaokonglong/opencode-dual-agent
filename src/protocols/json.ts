/**
 * 从模型输出中提取 JSON 载荷。
 * 模型输出视为不可信数据：只做提取与解析，不做执行。
 */

export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonExtractionError";
  }
}

const FENCE_RE = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/gi;

/**
 * 提取策略（按优先级）：
 * 1. 代码围栏中的 JSON
 * 2. 文本中第一个能通过 JSON.parse 的括号平衡片段
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new JsonExtractionError("模型输出为空，无法提取 JSON");

  const candidates: string[] = [];

  for (const match of text.matchAll(FENCE_RE)) {
    const body = (match[1] ?? "").trim();
    if (body.startsWith("{") || body.startsWith("[")) candidates.push(body);
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const balanced = sliceBalanced(text.slice(i));
    if (balanced) candidates.push(balanced);
  }

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 尝试下一个候选
    }
  }

  if (candidates.length > 0) {
    throw new JsonExtractionError("找到疑似 JSON 片段但均解析失败");
  }
  throw new JsonExtractionError("未在模型输出中找到合法 JSON 载荷");
}

/** 返回从下标 0 开始的第一个括号平衡片段；未闭合返回 null。 */
function sliceBalanced(text: string): string | null {
  const open = text[0];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

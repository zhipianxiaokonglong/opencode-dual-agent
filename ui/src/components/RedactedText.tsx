/**
 * 脱敏展示：`[REDACTED:*]` 以醒目遮罩样式渲染（契约 §3 视觉要求 7）。
 * 桥接服务已脱敏，UI 原样展示标记本身，但不暴露任何原文。
 */
const REDACTED_SPLIT = /(\[REDACTED(?::[^\]]*)?\])/g;
const REDACTED_MARK = /^\[REDACTED(?::[^\]]*)?\]$/;

export default function RedactedText({ text }: { text: string | null | undefined }) {
  const safe = text ?? "";
  const parts = safe.split(REDACTED_SPLIT);
  return (
    <>
      {parts.map((part, index) =>
        REDACTED_MARK.test(part) ? (
          <mark key={index} className="redacted" title="已脱敏">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

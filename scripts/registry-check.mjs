// registry:check 的文本比较工具。
//
// 背景：Windows CI 的 git 检出可能把生成文件写成 CRLF，而生成器输出 LF。
// 换行符不是生成内容的一部分——直接逐字节比较会让 34 个生成文件全部“过期”，
// 触发无意义的整仓重写。这里先规范化 CRLF/CR 为 LF 再比较；真正的字段差异
// 仍然会被抓到，并给出行号便于定位。

/** CRLF / 老式 CR 统一成 LF；函数不修改原字符串。 */
export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

/** 内容是否一致（忽略换行符差异）。 */
export function sameGeneratedContent(actual, expected) {
  return normalizeNewlines(actual) === normalizeNewlines(expected);
}

/** 找出第一处内容差异（已规范化换行）；完全一致返回 undefined。 */
export function describeMismatch(actual, expected) {
  const actualLines = normalizeNewlines(actual).split("\n");
  const expectedLines = normalizeNewlines(expected).split("\n");
  const total = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < total; i++) {
    if (actualLines[i] !== expectedLines[i]) {
      return {
        line: i + 1,
        actual: (actualLines[i] ?? "<EOF>").slice(0, 300),
        expected: (expectedLines[i] ?? "<EOF>").slice(0, 300),
      };
    }
  }
  return undefined;
}

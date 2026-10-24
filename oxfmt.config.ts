// 本包对共享 oxfmt 基线的唯一差异面（仓库自有，就地维护）。选项名经 OxfmtConfig 固化：
// 拼写错会被 tsc（tsconfig.json 的 include 含本文件）当场红，而不是被 oxfmt 静默忽略、
// 拖到 fmt:check 才以「文件未格式化」的形态暴露。
import type { OxfmtConfig } from "oxfmt";

export default {
  ignorePatterns: ["**/*.md", "**/*.jsonc"],
} satisfies OxfmtConfig;

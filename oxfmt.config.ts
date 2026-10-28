// 本包自有的 oxfmt 配置（shared/config/ 只提供 oxlint/tsconfig/vitest 基线，没有 oxfmt
// 基线可继承——本文件不是"共享基线的差异面"）。选项名经 OxfmtConfig 固化：拼写错会被
// tsc（tsconfig.json 的 include 含本文件）当场红，而不是被 oxfmt 静默忽略、拖到
// fmt:check 才以「文件未格式化」的形态暴露。ignorePatterns 只留确有匹配的项。
import type { OxfmtConfig } from "oxfmt";

export default {
  ignorePatterns: ["**/*.md"],
} satisfies OxfmtConfig;

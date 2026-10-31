// 本包自有的 oxfmt 配置（shared/config/ 只提供 oxlint/tsconfig/vitest 基线，没有 oxfmt
// 基线可继承——本文件不是"共享基线的差异面"）。选项名经 OxfmtConfig 固化：拼写错会被
// tsc（tsconfig.json 的 include 含本文件）当场红，而不是被 oxfmt 静默忽略、拖到
// fmt:check 才以「文件未格式化」的形态暴露。
//
// 排除项为空：oxfmt 本版本**确实**格式化 Markdown，随包发布的 README.md /
// README.zh-CN.md / CHANGELOG.md / THIRD_PARTY_NOTICES.md / docs/DETAIL*.md 也因此
// 过 fmt:check。此前那条 `**/*.md` 让这几份文档长期脱离格式化门禁（本轮实测四份
// 未格式化）；排除项只留"确有匹配且确实不该格式化"的项，现在是零项。
import type { OxfmtConfig } from "oxfmt";

export default {
  ignorePatterns: [],
} satisfies OxfmtConfig;

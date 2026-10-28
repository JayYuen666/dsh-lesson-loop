// test/log-templates.ts —— 本包算子可见日志的模板片段（与 lib 源码里的 console.* 逐条对账，手工维护）。
// 账本用它判「这条日志是不是源码里现存的模板」；新增 console.* 若没有对应片段，
// 跑测时那条日志就会被判未认领（见 test/setup-logs.ts）。这里不读盘：规则面
// （node/no-sync 等）不该为了测试脚手架开口子，且模板漂移应当是一次显式的改动。
//
// 片段的口径：优先取日志自带的 `[lesson-loop] ` 前缀 + 正文的可区分段；不带前缀的
// 中段片段只在该日志确实分参/插值导致前缀不在那一行时使用，且必须具体到只有那一条
// 源码日志含得下——宽泛的通用词（"undeterminable" 一类）会把新增未认领日志误判成
// 已认领，正好掩盖账本要抓的问题。
export const LOG_TEMPLATES = [
  '" 不可用（',
  " is unreadable (user layer or resolved value is not an array",
  ": session settled for project",
  "[lesson-loop] armed rule violated:",
  "[lesson-loop] candidate ready for review:",
  "[lesson-loop] commands service unavailable — /lessons-digest not registered",
  "[lesson-loop] ctx.provide unavailable — lessonLoop service invisible to reporters",
  "[lesson-loop] decay failed:",
  "[lesson-loop] decay:",
  "[lesson-loop] digest events payload is not an array",
  "[lesson-loop] digest output:",
  "[lesson-loop] digest persist failed:",
  "[lesson-loop] digest stream settled after the command already failed:",
  "[lesson-loop] fragment migration:",
  "[lesson-loop] fragment migration failed:",
  "[lesson-loop] project key migration:",
  "[lesson-loop] project key migration failed:",
  "[lesson-loop] save failed:",
  ": session settle for project",
  "[lesson-loop] sessionEnded failed:",
  "[lesson-loop] stats request failed:",
  "[lesson-loop] injected",
  "[lesson-loop] lesson append failed:",
  "[lesson-loop] lesson ledger unreadable",
  "[lesson-loop] lesson signature is not a string",
  '[lesson-loop] lesson source "',
  "[lesson-loop] migrated",
  "[lesson-loop] normalized",
  "[lesson-loop] pass failed:",
  "[lesson-loop] report failed:",
  "rule row(s) without a usable id dropped from",
  "[lesson-loop] rule-action handler failed:",
  '[lesson-loop] rules namespace rejected: "',
  "[lesson-loop] rules read failed:",
  "[lesson-loop] rules review service registration failed:",
  "[lesson-loop] rules write failed:",
  "[lesson-loop] session-start inject failed:",
  "[lesson-loop] settings provider has no CAS surface — rule library unavailable (switches still work)",
  "malformed lesson line(s) skipped in",
  "rule project key(s)",
  "，按 manual 记账",
] as const;

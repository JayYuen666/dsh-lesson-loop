// test/setup-logs.ts —— 插件运行日志的账本（vitest setupFile）。
//
// 为什么不用 vitest 的 `silent`：那只是不显示，新飘出来的日志照样没人看。这里把「跑测不该有
// 算子日志漏进报告」变成一条可判的契约：
//   ① 每条 `[<pkg>]` 日志必须含有 test/log-templates.ts 里的某个模板片段，否则当场红；
//   ② 带别家标签的日志出现在本包测试里也红（装配范围错了）；
//   ③ 生产侧一行不改：级别、文案、时机全部照旧，账本只在测试进程里接管输出。
// 用例要看日志内容时用 logged()/loggedText() 取，断言写在用例里。
//
// ⚠ 并行前提：records 是模块级共享数组 + 全局 console 接管，只在「用例串行执行」下成立。
// 同文件出现 test.concurrent（或某条用例把日志写进用例结束之后的悬空 Promise/定时器）时，
// A 用例的日志会落进 B 用例的账本——本仓测试全部串行，别在这里引入并发用例。
import { afterEach, beforeEach } from "vitest";
import assert from "node:assert/strict";

import { LOG_TEMPLATES } from "./log-templates.ts";

/** 本包标签前缀，如 `[lesson-loop]`。 */
const PKG_PREFIX = "[lesson-loop]";

/** 插件会用到的 console 级别（联合类型取属性，避免以字符串索引 Console）。
 *  debug/trace 也在内：源码新增这类调用而账本不接管，等于整条日志绕过本契约——
 *  级别名单必须覆盖插件实际可能用到的全集。 */
export type LogLevel = "info" | "warn" | "error" | "log" | "debug" | "trace";
const LEVELS: readonly LogLevel[] = ["info", "warn", "error", "log", "debug", "trace"];

/** 一次接管到的调用：拼平的首参 + 其余实参（堆栈通常就藏在其余实参里）。
 *  `text` 只拼首参，用于给人看的正文；`full` 把**全部实参**拼在一起，是标签归属与
 *  模板认领的判据 —— 插件允许把正文写成 `console.info("[lesson-loop]", msg)`，
 *  只看首参就会把这类日志判成"没写过"，标签在次参的也会漏出两道判定。 */
export interface LogRecord {
  /** 接管到的级别。目前没有断言消费它；留作按级别过滤的预留位（审计里按 `full` 归属）。 */
  level: LogLevel;
  text: string;
  full: string;
  /** 首参之外的实参（断言堆栈/明细时取这里；同样暂无消费者，与 level 同为预留位）。 */
  extra: unknown[];
}

/** 本条用例接管到的日志：数组身份常驻（每条用例清空而不是换一份，
 *  换引用会让 `logged()` 读到旧数组——原来是模块级 `let`，被 require-hook 判成裸赋值）。 */
const records: LogRecord[] = [];
const originals = new Map<LogLevel, (...args: unknown[]) => void>();
/** 接管标志：install/uninstall 必须成对幂等——重复 install 会把**自己的 spy** 存进
 *  originals，uninstall 之后 console 永远停在 spy 上，后续所有日志都被吞进 records
 *  且无法排查。 */
let installed = false;

/** 把一枚实参拼成一行：空白折成单空格，多行正文（缩进过的模板字面量）才能被片段命中。 */
function flatten(arg: unknown): string {
  return String(arg).replaceAll(/\s+/gu, " ");
}

/** 别家插件的标签形如 `[<包名>]`：允许大写、点分与 `@scope/pkg` 形态；**不能**用
 *  `startsWith("[")` 判：`String({})` 是 `[object Object]` 之类，会把普通对象当标签。
 *  名单内不含空白，`[object Object]` 一类天然不命中。 */
const FOREIGN_TAG = /^\[(?:@[\w.-]+\/)?[\w.-]+\]/iu;

/** 接管一个级别：处理器单独成函数，别在 for 里现造闭包（no-loop-func 拦的就是这个）。 */
function spyLevel(level: LogLevel): void {
  originals.set(level, console[level]);
  console[level] = (...args: unknown[]) => {
    const [first, ...rest] = args;
    records.push({
      level,
      text: flatten(first),
      full: args.map((arg) => flatten(arg)).join(" "),
      extra: rest,
    });
  };
}

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  for (const level of LEVELS) {
    spyLevel(level);
  }
}

function uninstall(): void {
  for (const [level, fn] of originals) {
    console[level] = fn;
  }

  originals.clear();
  installed = false;
}

function containsTemplate(record: LogRecord): boolean {
  return LOG_TEMPLATES.some((fragment) => record.full.includes(fragment));
}

/** 一次跑测的日志账本判定（纯函数，便于自带用例反验门禁本身拦不拦得住）。 */
export interface LedgerVerdict {
  /** 带别家插件标签的日志（装配范围错了）。 */
  strangers: string[];
  /** 本包日志里对不上任何模板片段的那些（新增 console.* 没认领 / 消息是临时拼的）。 */
  unclaimed: string[];
}

/** 判定一份日志账本。归属与认领都用 `full`（全部实参拼平）：标签在次参、正文分参的
 *  写法不能只看首参——只看首参会让这类日志既不算 stranger 也不进 unclaimed，整条
 *  绕过账本。 */
export function audit(entries: readonly LogRecord[]): LedgerVerdict {
  return {
    strangers: entries
      .filter((entry) => FOREIGN_TAG.test(entry.full))
      .filter((entry) => !entry.full.startsWith(PKG_PREFIX))
      .map((entry) => entry.full.slice(0, 120)),
    unclaimed: entries
      .filter((entry) => entry.full.startsWith(PKG_PREFIX))
      .filter((entry) => !containsTemplate(entry))
      .map((entry) => entry.full.slice(0, 120)),
  };
}

beforeEach(() => {
  records.length = 0;
  install();
});

afterEach(() => {
  uninstall();
  const verdict = audit(records);
  assert.deepEqual(verdict.strangers, [], "本包测试里出现了别家插件的日志：装配范围错了");
  assert.deepEqual(
    verdict.unclaimed,
    [],
    "这些日志对不上本包源码里的任何模板片段：新增 console.* 没有用例认领，或消息是临时拼的",
  );
});

/** 本条用例产生的插件日志，按调用顺序。 */
export function logged(): readonly LogRecord[] {
  return records.filter((record) => record.full.startsWith(PKG_PREFIX));
}

/** 拼平的日志正文，便于 match 断言（含全部实参：分参写法的正文也在这里）。 */
export function loggedText(): string {
  return logged()
    .map((record) => record.full)
    .join("\n");
}

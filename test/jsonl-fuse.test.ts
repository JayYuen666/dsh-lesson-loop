// jsonl-fuse 单元测试：磁盘保险丝的触发策略、锁的四条降级路径，以及 rename 前的
// 乐观并发控制（"读完之后有人追加过就放弃本轮裁剪"）。
//
// 为什么单独立一份：这一层此前只由 lesson-store 的用例间接覆盖，而它最关键的一条不变式
// ——**并发追加的事件不许被裁剪的 rename 抹掉**——必须有一条自己的判据。锁只串行持有者，
// 拿不到锁的一方走裸追加，它落进别人的 read→rename 窗口时会被整片覆盖（事件静默消失）。
//
// 那条窗口无法在单进程里用真实 fs 稳定制造（临界区全是同步调用），故只有它走 `statSync`
// 拦截：对**同一个路径**的第 1、2 次 stat 报真值（让快照取对），第 3 次起谎报"文件长了"。
// 真实 end-to-end 的竞争由 /tmp 下的双进程夹具体现，不放进本文件（那会是一条靠时序的用例）。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendUnderFuse } from "../lib/jsonl-fuse.ts";

/** statSync 拦截开关：`armed` 时对 `file` 的第 3 次起 stat 谎报尺寸。 */
const statHook = vi.hoisted(() => ({ armed: false, file: "", calls: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  /** 只对"被瞄准的那个文件"计数并撒谎，其余路径一律穿透到真实实现。 */
  const statSync = (target: unknown, ...rest: unknown[]): { size: number } => {
    const real = (actual.statSync as (...args: unknown[]) => { size: number })(target, ...rest);
    if (!statHook.armed || String(target) !== statHook.file) {
      return real;
    }
    statHook.calls += 1;
    // 1 = 进入裁剪前的超限判定，2 = 读完后的快照基准，3+ = rename 前那道判据。
    // 只有第 3 次起撒谎，快照才是真的。
    return statHook.calls >= 3 ? { ...real, size: real.size + 1 } : real;
  };
  return { ...actual, statSync };
});

/** 与生产同形的单条流水行（前导换行 + 结尾换行）。 */
const payloadOf = (value: object): string => `\n${JSON.stringify(value)}\n`;
/** 造一个"远超上限"的种子：两段各 200 字节，裁尾只保最新那段。 */
const OLD = `${"a".repeat(200)}\n`;
const NEW = `${"b".repeat(200)}\n`;

describe("jsonl-fuse", () => {
  // 每个用例一个独立临时目录：`beforeEach` 里建、`afterEach` 里删。
  // 声明成 `string` 而非空串初始化——空串初值会被 require-hook 规则当成 describe 体内的
  // setup 语句（它读不出这个赋值其实只是类型占位）。
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "dsh-jsonl-fuse-"));
    statHook.armed = false;
    statHook.file = "";
    statHook.calls = 0;
  });

  afterEach(() => {
    statHook.armed = false;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("未超上限 → 不裁，只追加（照旧写进同一份文件）", () => {
    const file = path.join(scratch, "small.jsonl");
    writeFileSync(file, "keep\n");
    appendUnderFuse(file, payloadOf({ a: 1 }), 10_000);
    // payload 自带前导换行（封残行用），故落盘是 "keep" + 空行 + 记录。
    assert.equal(readFileSync(file, "utf8"), `keep\n${payloadOf({ a: 1 })}`);
  });

  it("超上限且无人并发 → 真裁：旧的一段消失、最新那段与本次追加都在", () => {
    const file = path.join(scratch, "shrink.jsonl");
    writeFileSync(file, `${OLD}${NEW}`);
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(OLD), "更旧的那段被裁掉");
    assert.ok(text.includes(NEW), "最新那段留着");
    assert.ok(text.endsWith(payloadOf({ a: 1 })), "本次追加落在新文件尾");
  });

  it("maxBytes = 0 → 永不截断（出厂默认那条承诺）", () => {
    const file = path.join(scratch, "unlimited.jsonl");
    writeFileSync(file, `${OLD}${NEW}`);
    appendUnderFuse(file, payloadOf({ a: 1 }), 0);
    assert.equal(readFileSync(file, "utf8"), `${OLD}${NEW}${payloadOf({ a: 1 })}`);
  });

  it("读完之后文件被追加过（拿不到锁的一方落进了窗口）→ 放弃本轮裁剪，绝不丢那一行", () => {
    const file = path.join(scratch, "raced.jsonl");
    const oversized = `${OLD}${NEW}`;
    writeFileSync(file, oversized);
    statHook.armed = true;
    statHook.file = file;
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    assert.equal(
      readFileSync(file, "utf8"),
      `${oversized}${payloadOf({ a: 1 })}`,
      "判据发现有人在 read 之后写过：本轮不裁（宁可超配额），那一行必须还在",
    );
    assert.equal(statHook.calls, 3, "三次 stat：超限判定 / 快照基准 / rename 前的判据");
  });

  it("拿不到锁（别人的新锁）→ 追加照常、裁剪跳过，且不碰别人的锁", () => {
    const file = path.join(scratch, "busy.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, OLD);
    writeFileSync(lock, "");
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    assert.equal(readFileSync(file, "utf8"), `${OLD}${payloadOf({ a: 1 })}`, "只跳过裁剪");
    assert.ok(existsSync(lock), "别人的锁不得被我们顺手删掉");
  });

  it("陈旧锁（超龄）→ 接管后照常裁剪，临界区结束归还锁", () => {
    const file = path.join(scratch, "stale.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, `${OLD}${NEW}`);
    writeFileSync(lock, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(OLD), "陈旧锁被接管：更旧的那段裁掉了");
    assert.ok(text.endsWith(payloadOf({ a: 1 })), "本次追加落在新文件尾");
    assert.ok(!existsSync(lock), "接管成功=我们成了持有者，临界区结束要释放");
  });

  it("陈旧锁但接管失败（锁路径是目录）→ 跳过裁剪，本次追加不丢", () => {
    const file = path.join(scratch, "dirlock.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, OLD);
    mkdirSync(lock);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    assert.equal(readFileSync(file, "utf8"), `${OLD}${payloadOf({ a: 1 })}`, "接管失败只跳过裁剪");
    assert.ok(existsSync(lock), "接管失败的锁保持原样");
  });
});

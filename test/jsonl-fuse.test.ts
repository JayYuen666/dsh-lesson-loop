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
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendUnderFuse } from "../lib/jsonl-fuse.ts";

/** statSync 拦截开关：`armed` 时对 `file` 的第 3 次起 stat 谎报尺寸；`mode = "throw"` 抛错。 */
const statHook = vi.hoisted(() => ({
  armed: false,
  file: "",
  calls: 0,
  mode: "" as "" | "throw",
}));
/** renameSync 拦截开关：`armed` 时对目标为 `file` 的 rename 抛错；`anyFile` 时对任何源抛错。 */
const renameHook = vi.hoisted(() => ({
  armed: false,
  file: "",
  calls: 0,
  anyFile: false,
}));
/** readFileSync 拦截开关：`mode = "throw"` 抛 ENOENT，`"truncate"` 返回截断后的正文。 */
const readHook = vi.hoisted(() => ({ mode: "" as "" | "throw" | "truncate", file: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  /** 只对"被瞄准的那个文件"计数并撒谎，其余路径一律穿透到真实实现。 */
  const statSync = (target: unknown, ...rest: unknown[]): { size: number } => {
    if (statHook.armed && statHook.mode === "throw" && String(target) === statHook.file) {
      statHook.calls += 1;
      throw Object.assign(new Error("ENOENT: 锁在这一瞬被释放了"), { code: "ENOENT" });
    }
    const real = (actual.statSync as (...args: unknown[]) => { size: number })(target, ...rest);
    if (!statHook.armed || String(target) !== statHook.file) {
      return real;
    }
    statHook.calls += 1;
    // 1 = 进入裁剪前的超限判定，2 = 读完后的快照基准，3+ = rename 前那道判据。
    // 只有第 3 次起撒谎，快照才是真的。
    return statHook.calls >= 3 ? { ...real, size: real.size + 1 } : real;
  };
  const renameSync = (source: unknown, destination: unknown): void => {
    if (renameHook.armed && (renameHook.anyFile || String(destination) === renameHook.file)) {
      renameHook.calls += 1;
      throw new Error("模拟 rename 失败");
    }
    (actual.renameSync as (from: unknown, to: unknown) => void)(source, destination);
  };
  const readFileSyncSpy = (target: unknown, ...rest: unknown[]): unknown => {
    if (readHook.mode !== "" && String(target) === readHook.file) {
      if (readHook.mode === "throw") {
        throw Object.assign(new Error("ENOENT: 文件已被移走"), { code: "ENOENT" });
      }
      const text = (actual.readFileSync as (...args: unknown[]) => string)(target, "utf8");
      return text.slice(0, Math.max(0, text.length - 1));
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
  };
  return { ...actual, statSync, renameSync, readFileSync: readFileSyncSpy };
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
    statHook.mode = "";
    renameHook.armed = false;
    renameHook.file = "";
    renameHook.calls = 0;
    renameHook.anyFile = false;
    readHook.mode = "";
    readHook.file = "";
  });

  afterEach(() => {
    statHook.armed = false;
    renameHook.armed = false;
    readHook.mode = "";
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

  it("裁剪写临时文件/rename 失败 → 临时文件被清掉、错因不上抛，本次追加照常落盘", () => {
    const file = path.join(scratch, "rename-fail.jsonl");
    writeFileSync(file, `${OLD}${NEW}`);
    renameHook.armed = true;
    renameHook.file = file;
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    // rename 失败 => 本轮裁剪放弃（旧段还在），临界区继续走完，追加不丢。
    assert.equal(readFileSync(file, "utf8"), `${OLD}${NEW}${payloadOf({ a: 1 })}`);
    // 唯一命名的临时文件被内层 catch 清掉：目录里只该剩数据文件（锁已释放）。
    assert.deepEqual(
      readdirSync(scratch).filter((name) => name.endsWith(".tmp")),
      [],
      "失败路径必须清掉自己的临时文件，别留给下一轮",
    );
  });

  it("拿不到锁且回读发现这一行没落盘（被持有者 rename 覆盖）→ 补写一次", () => {
    const file = path.join(scratch, "fuse-retry.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, OLD);
    // 别人的新锁：走裸追加那一路。
    writeFileSync(lock, "");
    readHook.mode = "truncate";
    readHook.file = file;
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    // 断言面必须是真文件内容，别让钩子把自己也截了。
    readHook.mode = "";
    // 读取被截断 => 尾部比对判"不在" => 补写；于是这一行出现两次（宁可重复，绝不丢）。
    assert.equal(
      readFileSync(file, "utf8"),
      `${OLD}${payloadOf({ a: 1 })}${payloadOf({ a: 1 })}`,
      "尾部比对失败时补写一次",
    );
  });

  it("拿不到锁且回读时文件已不存在（读抛错）→ 按「不在」处理并补写", () => {
    const file = path.join(scratch, "fuse-vanish.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, OLD);
    // 别人的新锁：走裸追加那一路。
    writeFileSync(lock, "");
    readHook.mode = "throw";
    readHook.file = file;
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    // 断言面必须是真文件内容，别让钩子把自己也挡了。
    readHook.mode = "";
    // 读不到就补写：补写那次是真 fs 写，所以文件末尾一定有这一行。
    const tail = readFileSync(file, "utf8");
    assert.ok(tail.endsWith(payloadOf({ a: 1 })), "读不到文件不等于这一行在，必须补写");
  });

  it("陈旧锁但 stat 不到（锁在这一瞬被释放）→ 这一轮让位，追加照常", () => {
    const file = path.join(scratch, "stat-gone.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, OLD);
    writeFileSync(lock, "");
    statHook.armed = true;
    statHook.file = lock;
    statHook.mode = "throw";
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    statHook.armed = false;
    assert.equal(readFileSync(file, "utf8"), `${OLD}${payloadOf({ a: 1 })}`, "只跳过裁剪");
  });

  it("陈旧锁但搬不走（rename 失败）→ 这一轮不再抢锁，追加照常", () => {
    const file = path.join(scratch, "rename-lock.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, OLD);
    writeFileSync(lock, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    renameHook.armed = true;
    renameHook.anyFile = true;
    appendUnderFuse(file, payloadOf({ a: 1 }), 10);
    renameHook.armed = false;
    assert.equal(readFileSync(file, "utf8"), `${OLD}${payloadOf({ a: 1 })}`, "接管失败只跳过裁剪");
    assert.ok(existsSync(lock), "搬不走的锁保持原样");
  });

  it("归还锁时读到不匹配的令牌（锁已被别人接管）→ 不删那把锁", () => {
    const file = path.join(scratch, "not-mine.jsonl");
    const lock = `${file}.lock`;
    writeFileSync(file, "keep\n");
    // 本进程确实拿到了锁（createLock 成功），但临界区期间锁可能被按陈旧接管走了。
    // 让 releaseLock 读到被截断一位的正文即等价于"这锁不是我的了"。
    readHook.mode = "truncate";
    readHook.file = lock;
    appendUnderFuse(file, payloadOf({ a: 1 }), 10_000);
    readHook.mode = "";
    assert.ok(existsSync(lock), "令牌不匹配时不许删锁");
    assert.match(readFileSync(lock, "utf8"), /^\d+\./u, "锁里仍是那枚持有者令牌");
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

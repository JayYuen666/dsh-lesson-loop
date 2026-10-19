// jsonl-fuse：JSONL 的**磁盘保险丝**——文件超过 maxBytes 就按行裁尾，只保最新那一段；
// 裁剪与追加共用同一把跨进程排他锁，两条写路径在同一临界区里串行。
//
// 为什么与 lib/lesson-jsonl.ts 分家：那一份管"流水怎么写进去、怎么读回来"，这一份管"磁盘
// 快撑不住时砍掉多少"。两件事的判据来源不同——裁尾算法本体在 shared/lib/jsonl.ts（与
// ctx-observe 同源、穷举比对磁盘内容后无分歧），本文件只另外负责**触发策略**（只在
// maxBytes > 0 时收缩，出厂默认 0 = 永不截断，那是写进本包 README 的承诺）、**错误出口**
// （裁剪失败只吞不抛，绝不误伤紧接着的这次追加）与**并发纪律**（锁）。
//
// 为什么追加也要进临界区：追加是 O_APPEND 写、裁剪是"读整份 → 写临时文件 → rename 覆盖"。
// 两进程各写各的时，另一进程在「裁剪读完、rename 之前」追加的那一行会被新内容整体覆盖掉
// （事件静默消失，而 report 仍回 ok）。锁只把**持有者之间**的读改写串行，这还不够：
// **拿不到锁时仍然追加、只跳过裁剪**（宁可这轮不裁，绝不丢事件），那条裸追加照样可能落进
// 持有者的 read→rename 窗口。所以持有者还要在 rename 前做一次乐观并发控制——比对快照字节数
// 与当前字节数，变了就放弃本轮裁剪（见 shrinkLocked）。代价是两进程持续抢写时裁剪可能长期
// 不生效（文件停在 maxBytes 之上）：这是"最多超配额"换"绝不丢事件"的刻意取舍。
// 锁的覆盖面因此包含 maxBytes = 0 的纯追加（那时没有读改写，但别的进程可能正举着裁剪）。
//
// 原子替换的取舍：`.tmp` + rename 让读者（readJsonl）要么见旧全文、要么见新全文，不会读到
// 写了一半的中间态；代价是崩溃时可能留下 `.lock` / `.tmp` 两个兄弟文件——锁文件 mtime 超过
// {@link LOCK_STALE_MS} 即视为持有者已死、可被接管；`.tmp` 是整份覆盖写，下一轮裁剪自然复用。

import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { shrinkJsonlTail } from "@jayyuen66/dsh-plugin-shared/lib/jsonl";

/** 锁文件视为陈旧的门槛：临界区全是同步调用（微秒级），10s 没释放只可能是持有者死了
 *  （进程崩溃/被 SIGKILL）。没有这一层，一次崩溃会让该文件的裁剪永久停摆。 */
const LOCK_STALE_MS = 10_000;

/** 陈旧锁接管：新锁让位（false）；超龄则 rm 掉重抢（抢输/失败仍 false）。 */
function takeOverStaleLock(lock: string): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) {
      return false;
    }
    rmSync(lock, { force: true });
    writeFileSync(lock, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** 尝试取锁：先以 `wx`（O_CREAT|O_EXCL）原子占位；占不到时只有**陈旧**锁才允许接管。
 *  任何一步 fs 失败都按"拿不到"处理——热路径只许降级，不许抛。 */
function tryAcquireLock(lock: string): boolean {
  try {
    writeFileSync(lock, "", { flag: "wx" });
    return true;
  } catch {
    return takeOverStaleLock(lock);
  }
}

/** 在排他锁下执行临界区；拿不到锁返回 false（什么都不执行）。临界区无论成败都释放锁
 *  （finally）——失败路径也把锁还回去，别让后来者等到"陈旧"。 */
function withLock(file: string, action: () => void): boolean {
  const lock = `${file}.lock`;
  if (!tryAcquireLock(lock)) {
    return false;
  }
  try {
    action();
  } finally {
    rmSync(lock, { force: true });
  }
  return true;
}

/** 裁剪本体（**只允许在锁内调用**）：读整份 → 按行裁尾 → 临时文件 + 原子 rename。
 *  错误出口在这里吞掉：裁剪是尽力而为，失败绝不误伤调用方紧接着的这次追加。
 *
 *  rename 之前还有一道**乐观并发控制**：锁只串行持有者，拿不到锁的一方走的是裸追加
 *  （见 appendUnderFuse），它若在本函数读完、rename 之前落笔，rename 会把那一行整片覆盖
 *  ——事件静默消失而追加方已正常返回。故用"读完那一刻的字节数"当快照，rename 前再比一次：
 *  变了就说明有人在我们读之后写过，**放弃本轮裁剪**。
 *  取舍：持续抢写时裁剪可能长期不生效（文件停在 maxBytes 之上），换来的是绝不丢事件。
 *  基准取在 readFileSync **之后**：read 与取基准之间落进来的追加只会让我们白放弃一轮，
 *  而按解码后的字节数比会在文件里有非法 UTF-8 时永久放弃裁剪。 */
function shrinkLocked(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size <= maxBytes) {
      return;
    }
    const text = readFileSync(file, "utf8");
    const snapshotBytes = statSync(file).size;
    const shrunk = shrinkJsonlTail(text, maxBytes);
    if (shrunk === text || statSync(file).size !== snapshotBytes) {
      return;
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, shrunk);
    renameSync(tmp, file);
  } catch {
    /* 截断尽力而为 */
  }
}

/**
 * 保险丝下的 JSONL 追加：`payload` 是要原样写进去的字节（行边界由调用方自己保证）。
 * 同一把锁内「先裁后写」，与别的进程（以及本进程的其它临界区）串行；拿不到锁则跳过裁剪、
 * 照常追加。**追加本身的失败不吞**：由调用方按各自的失败纪律记日志（本包的出口在
 * lib/lesson-jsonl.ts 的 catch）。
 */
export function appendUnderFuse(file: string, payload: string, maxBytes: number): void {
  const locked = withLock(file, () => {
    if (maxBytes > 0) {
      shrinkLocked(file, maxBytes);
    }
    appendFileSync(file, payload);
  });
  if (!locked) {
    appendFileSync(file, payload);
  }
}

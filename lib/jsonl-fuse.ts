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
// 写了一半的中间态。代价是崩溃时可能留下兄弟文件：`.lock`（mtime 超过 {@link LOCK_STALE_MS}
// 即视为持有者已死、可被接管）与一枚**按持有者唯一命名**的 `.tmp`（一次崩溃残留一份，不覆盖
// 别人的在途临时文件；进程正常退出的路径会自己删掉）。

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { shrinkJsonlTail } from "@jayyuen66/dsh-plugin-shared/lib/jsonl";

/** 锁文件视为陈旧的门槛：临界区全是同步调用（微秒级），10s 没释放只可能是持有者死了
 *  （进程崩溃/被 SIGKILL）。没有这一层，一次崩溃会让该文件的裁剪永久停摆。 */
const LOCK_STALE_MS = 10_000;

/** 本次进程的锁持有者令牌：写进锁文件正文，释放时据此确认"这锁还是我的"。
 *  进程号只用于事后读日志时对得上是谁，唯一性由 randomUUID 给。 */
function newToken(): string {
  return `${process.pid}.${randomUUID()}`;
}

/** 以 `wx`（O_CREAT|O_EXCL）原子建锁并写入持有者令牌；建不到返回 false。 */
function createLock(lock: string, token: string): boolean {
  try {
    writeFileSync(lock, token, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** 陈旧锁接管：新锁让位（false）；超龄则**原子搬走**再重抢（抢输/失败仍 false）。
 *
 *  不能写成 `rmSync` + `writeFileSync` 两步：两个进程同时判到"超龄"时，A 的 rm 与 B 的 rm
 *  都会成功，接着 A 的 wx 与 B 的 wx 里只有一个能建 —— 看似还好，真正坏的是 B 的 rm 可能落在
 *  A 建新锁**之后**，把 A 刚拿到的锁删掉，于是两个持有者同时进临界区。`renameSync` 只有一个
 *  进程能成功（失败方拿 ENOENT），"搬走"这一步本身就是那次裁决。 */
function takeOverStaleLock(lock: string, token: string): boolean {
  let stale: number;
  try {
    const info = statSync(lock);
    // 只接管**普通文件**形态的锁：锁路径上若是目录（崩溃残留、或有人手动建的），它不是
    // 本机制写的锁，接管它等于替别人清理现场——那一轮让位，保留现场给读日志的人。
    if (!info.isFile()) {
      return false;
    }
    stale = Date.now() - info.mtimeMs;
  } catch {
    // stat 不到 = 锁在这一瞬被别人释放/接管了；这一轮让位，下一轮重试。
    return false;
  }
  if (stale <= LOCK_STALE_MS) {
    return false;
  }
  const grave = `${lock}.${token}.stale`;
  try {
    renameSync(lock, grave);
  } catch {
    // 搬不走 = 别人抢先接管或已释放；无论哪种，这一轮都不该继续抢。
    return false;
  }
  const acquired = createLock(lock, token);
  try {
    rmSync(grave, { force: true });
  } catch {
    // 墓碑删不掉只会留下一枚带持有者令牌的死文件，不影响锁的正确性。
  }
  return acquired;
}

/** 尝试取锁：先以 `wx` 原子占位；占不到时只有**陈旧**锁才允许接管。
 *  任何一步 fs 失败都按"拿不到"处理——热路径只许降级，不许抛。
 *  @returns 成功时的持有者令牌，失败为 null */
function tryAcquireLock(lock: string): string | null {
  const token = newToken();
  if (createLock(lock, token)) {
    return token;
  }
  return takeOverStaleLock(lock, token) ? token : null;
}

/** 归还锁：**只删自己那把**。
 *
 *  无所有权校验的 `rmSync(lock, {force:true})` 在一种情形下会删错人：临界区因故障拖过
 *  {@link LOCK_STALE_MS}，别的进程按陈旧把它接管了，随后我们的 finally 把**对方的**锁删掉
 *  —— 第三人立刻就能进临界区，与对方并发。锁文件正文里那枚令牌就是这条判据。 */
function releaseLock(lock: string, token: string): void {
  try {
    if (readFileSync(lock, "utf8") !== token) {
      return;
    }
    rmSync(lock, { force: true });
  } catch {
    // 读不到 = 锁已不在（被别人清掉/接管并删了墓碑）：没有可归还的东西。
  }
}

/** 在排他锁下执行临界区；拿不到锁返回 false（什么都不执行）。临界区无论成败都释放锁
 *  （finally）——失败路径也把锁还回去，别让后来者等到"陈旧"。 */
function withLock(file: string, action: () => void): boolean {
  const lock = `${file}.lock`;
  const token = tryAcquireLock(lock);
  if (token === null) {
    return false;
  }
  try {
    action();
  } finally {
    releaseLock(lock, token);
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
 *  而按解码后的字节数比会在文件里有非法 UTF-8 时永久放弃裁剪。
 *
 *  rename 之前那一次 stat 只能把窗口缩到「stat 之后、rename 之前」，关不死——两次系统调用
 *  之间没有原子性可用。真正兜住漏网那一行的是追加侧的 lineSurvivedFuse：rename 覆盖掉
 *  的尾部追加由追加方自己读回并补写。两侧各让一步，这条不变式才闭合。 */
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
    // 临时文件按持有者唯一命名：固定 `${file}.tmp` 会让两个进程在同一个临时文件上互相
    // 覆盖（A 写完 shrunk、B 覆盖成自己的、A rename —— 落盘的是谁的正文全看时序）。
    // 名字里带 pid 与随机 uuid，同一进程内的多次裁剪也不会互相踩。
    const tmp = `${file}.${newToken()}.tmp`;
    try {
      writeFileSync(tmp, shrunk);
      renameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 临时文件删不掉不值得盖住真正的错因；它带唯一名字，不会挡住下一轮。
      }
      throw error;
    }
  } catch {
    /* 截断尽力而为 */
  }
}

/**
 * 裸追加之后的自查：这一行还在文件里吗？不在就补写。
 *
 * 为什么需要：拿不到锁的一方走裸追加，而锁的持有者可能正处在这条窗口里——它已经读完
 * 整份、取了快照、做过 rename 前那次 stat，我们这一行恰好落在 stat 之后、rename 之前，
 * 于是被 rename 整片覆盖（事件静默消失，而追加方已正常返回）。shrinkLocked 的那次
 * stat 只能把窗口缩窄，不能关死：两次系统调用之间没有原子性可用。
 *
 * 判据用「尾部是否以本次写的这批字节结尾」而不是字节数比对：持有者的 READ 可能落在
 * 我们读完、写之前，那时它会把这行也算进 snapshot，字节数判据会误判成"没被覆盖"。
 * 尾部比对对这种情况是保守的（宁可多写一次也不吞事件），代价是极端并发下可能重复一行，
 * 而流水侧对重复行的容忍度远高于对丢事件的容忍度（derived 数据，读侧按 fingerprint 去重）。
 *
 * 仍然可能漏：我们读完、判定"在"、然后才被覆盖的那一瞬。这一层把概率压到"必须精确命中
 * 微秒级窗口"，不宣称消灭它——真正的消灭要跨进程事务，代价远高于这份派生数据的价值。
 */
function lineSurvivedFuse(file: string, payload: string): boolean {
  try {
    const text = readFileSync(file, "utf8");
    return text.endsWith(payload);
  } catch {
    // 读不到文件（被 rename 到别处/刚才还不存在）：按"不在"处理，让调用方补写。
    return false;
  }
}

/**
 * 保险丝下的 JSONL 追加：`payload` 是要原样写进去的字节（行边界由调用方自己保证）。
 * 同一把锁内「先裁后写」，与别的进程（以及本进程的其它临界区）串行；拿不到锁则跳过裁剪、
 * 照常追加，并在追加后确认那一行没被持有者的 rename 覆盖（见 lineSurvivedFuse）。
 * **追加本身的失败不吞**：由调用方按各自的失败纪律记日志（本包的出口在
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
    if (!lineSurvivedFuse(file, payload)) {
      appendFileSync(file, payload);
    }
  }
}

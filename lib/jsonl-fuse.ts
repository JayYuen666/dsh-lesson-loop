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
// 写了一半的中间态。代价是崩溃时可能留下兄弟文件：`.lock`（超龄即视为持有者已死、可被接管，
// 超龄门槛随数据文件大小放大，见 {@link LOCK_STALE_MS}）与一枚**按持有者唯一命名**的
// `.tmp`（一次崩溃残留一份，不覆盖别人的在途临时文件；进程正常退出的路径会自己删掉）。

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { shrinkJsonlTail } from "@jayyuen66/dsh-plugin-shared/lib/jsonl";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 锁文件视为陈旧的**基础**门槛：正常临界区是同步调用，量级在毫秒；超时只可能是持有者
 *  死了（进程崩溃/被 SIGKILL）或临界区被大文件拖慢。没有这一层，一次崩溃会让该文件的
 *  裁剪永久停摆。 */
const LOCK_STALE_MS = 10_000;

/** 陈旧门槛随数据文件大小的放大率（字节/毫秒）：临界区是"读整份 → 写整份 → rename"，
 *  按 ≥20 MB/s 的保守磁盘速度估算耗时，把这段耗时加进陈旧门槛——否则几十上百 MB 的
 *  流水在慢盘上会超过基础门槛，被别的进程按"陈旧"接管一把**仍在使用**的锁。估算宁可
 *  偏慢（门槛偏大）：门槛过大只推迟接管（裁剪多等一轮，追加与读取不受影响），门槛过小
 *  却制造双持有者。
 *  20 MB/s = 20 × 1024 × 1024 / 1000 ≈ 20_972 字节/毫秒（取 20_480 = 20 KiB/ms，
 *  即 20.48 MB/s）；此前写成 20 是单位错（只有约 20 KB/s），100 MB 的流水会得到
 *  ~83 分钟的陈旧门槛，裁剪要停摆一个多小时。 */
const STALE_BYTES_PER_MS = 20_480;

/** 流水文件**新建**时的权限：内容里有工具错误原文、命令串与路径，只给属主读写。
 *  mode 只在创建那一刻生效（已存在的文件保持原 mode，与目录同一条纪律）——目录侧
 *  0o700 只覆盖"目录由本进程创建"的形态，缓存目录常由宿主预先建好，文件这一道必须
 *  自己收口，否则 appendFileSync 按 0o666 & umask（常见 0644）建出来。 */
const LEDGER_FILE_MODE = 0o600;

/** ENOENT 判据（与 lib/lesson-jsonl.ts 同口径）：只把"文件确实不在"当成被覆盖。 */
function isEnoent(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

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

/** "物归原主"的无覆盖恢复：把墓碑搬回锁路径，**只在原位仍空着时**落地。
 *
 *  为什么不能用 renameSync：rename 会替换目标（POSIX 语义），从"锁被搬走"到"搬回"的
 *  窗口里第三方可能已经建了新锁，rename 会把别人的新锁换成墓碑里那份旧文件——它已超龄，
 *  别人按陈旧接管，双持有者。硬链接对已存在的目标抛 EEXIST，恢复因此是"原子且不覆盖"的；
 *  失败时墓碑留着（带本进程令牌的唯一命名），回收交给陈旧接管。 */
function restoreLock(source: string, target: string): void {
  let restored = false;
  try {
    linkSync(source, target);
    restored = true;
  } catch {
    // 原位已被第三方占住（EEXIST）或文件系统不支持硬链接：留着墓碑，不覆盖别人的锁。
  }
  if (restored) {
    try {
      rmSync(source, { force: true });
    } catch {
      // 删不掉只是留下一枚带本进程令牌的墓碑，不影响锁的正确性。
    }
  }
}

/** 陈旧锁接管：新锁让位（false）；超龄则**原子搬走**再重抢（抢输/失败仍 false）。
 *
 *  不能写成 `rmSync` + `writeFileSync` 两步：两个进程同时判到"超龄"时，A 的 rm 与 B 的 rm
 *  都会成功，接着 A 的 wx 与 B 的 wx 里只有一个能建 —— 看似还好，真正坏的是 B 的 rm 可能落在
 *  A 建新锁**之后**，把 A 刚拿到的锁删掉，于是两个持有者同时进临界区。`renameSync` 只有一个
 *  进程能成功（失败方拿 ENOENT），"搬走"这一步本身就是那次裁决。
 *
 *  搬走之后还要**验明搬走的确实是刚才判到超龄的那把锁**：从判龄到 rename 之间，别的进程
 *  可能已经搬走老锁、建了**一把新鲜的新锁**——不验就等于把别人的新锁搬进墓碑，紧接着
 *  createLock 成功，两个持有者同时进临界区。验法：rename 前记下锁的 ino 与 mtimeMs，
 *  rename 后对墓碑再 stat 一次比对；不一致说明搬错了人，把墓碑搬回原位（原位若已被第三个
 *  进程占住，linkSync 会 EEXIST 而绝不替换别人的新锁；那枚墓碑留给陈旧接管回收）并
 *  放弃本轮。 */
function takeOverStaleLock(lock: string, file: string, token: string): boolean {
  let staleIno: number;
  let staleMtimeMs: number;
  let staleMs: number;
  try {
    const info = statSync(lock);
    // 只接管**普通文件**形态的锁：锁路径上若是目录（崩溃残留、或有人手动建的），它不是
    // 本机制写的锁，接管它等于替别人清理现场——那一轮让位，保留现场给读日志的人。
    if (!info.isFile()) {
      return false;
    }
    // 超龄门槛 = 基础门槛 + 按数据文件大小估算的临界区耗时；数据文件 stat 不到时
    // （恰好被裁剪 rename 走）按 0 字节取基础门槛，下一轮再试。
    let bytes = 0;
    try {
      bytes = statSync(file).size;
    } catch {
      // 数据文件 stat 不到（恰好被裁剪 rename 走）：按 0 取基础门槛，下一轮再试。
    }
    staleMs = LOCK_STALE_MS + Math.ceil(bytes / STALE_BYTES_PER_MS);
    staleIno = info.ino;
    staleMtimeMs = info.mtimeMs;
  } catch {
    // stat 不到 = 锁在这一瞬被别人释放/接管了；这一轮让位，下一轮重试。
    return false;
  }
  if (Date.now() - staleMtimeMs <= staleMs) {
    return false;
  }
  const grave = `${lock}.${token}.stale`;
  try {
    renameSync(lock, grave);
  } catch {
    // 搬不走 = 别人抢先接管或已释放；无论哪种，这一轮都不该继续抢。
    return false;
  }
  let movedTheStaleLock: boolean;
  try {
    const graveInfo = statSync(grave);
    movedTheStaleLock = graveInfo.ino === staleIno && graveInfo.mtimeMs === staleMtimeMs;
  } catch {
    // 墓碑 stat 不到 = 有东西把刚搬走的锁又动走了：这已经不在本机制的剧本里，
    // 下一轮重试比硬抢安全。
    return false;
  }
  if (!movedTheStaleLock) {
    // 搬走的是别人的新锁：无覆盖地放回原位，本轮让位（见 restoreLock 的取舍）。
    restoreLock(grave, lock);
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
function tryAcquireLock(lock: string, file: string): string | null {
  const token = newToken();
  if (createLock(lock, token)) {
    return token;
  }
  return takeOverStaleLock(lock, file, token) ? token : null;
}

/** 归还锁：**只删自己那把**，且裁决与搬走是同一步。
 *
 *  无所有权校验的 `rmSync(lock, {force:true})` 在两种情形下都会删错人：临界区拖过超龄门槛
 *  被别人接管后，我们删的是**对方的**锁；以及"读到自己的令牌"与"rm"之间锁被接管——令牌
 *  校验只能缩小窗口、关不死。改成**原子搬走再验**：rename 这一发生，锁文件就从共享路径上
 *  消失（接管者要么已把它搬走让我们的 rename 拿 ENOENT、要么我们的 rename 搬走的是它刚建
 *  的新锁）；搬走后读墓碑里的令牌，是自己的就删，不是自己的就**无覆盖地**放回原位
 *  （linkSync：原位已被第三方占住就留墓碑，不替换别人的锁——无条件 rename 会制造
 *  "第三方以为自己持锁、别人却按超龄接管"的双持有者）。 */
function releaseLock(lock: string, token: string): void {
  const released = `${lock}.${token}.released`;
  try {
    renameSync(lock, released);
  } catch {
    // 锁已不在（被接管者搬走/被别人清掉）：没有可归还的东西。
    return;
  }
  let content: string;
  try {
    content = readFileSync(released, "utf8");
  } catch {
    // 刚搬走的墓碑读不到：留着它（带本进程令牌的唯一命名），不冒认领风险。
    return;
  }
  if (content !== token) {
    // 搬走的是接管者的新锁：无覆盖地放回原位；原位被占就留墓碑，不误删也不替换别人。
    restoreLock(released, lock);
    return;
  }
  try {
    rmSync(released, { force: true });
  } catch {
    // 删不掉只会留下一枚带自己令牌的死文件，不影响锁的正确性。
  }
}

/** 在排他锁下执行临界区；拿不到锁返回 false（什么都不执行）。临界区无论成败都释放锁
 *  （finally）——失败路径也把锁还回去，别让后来者等到"陈旧"。 */
function withLock(file: string, action: () => void): boolean {
  const lock = `${file}.lock`;
  const token = tryAcquireLock(lock, file);
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
 *  （见 appendUnderFuse），它若在本函数读与 rename 之间落笔，rename 会把那一行整片覆盖
 *  ——事件静默消失而追加方已正常返回。故用**读取开始之前那一刻的字节数**当快照，rename
 *  前再比一次：变了就说明有人在我们取快照之后写过，**放弃本轮裁剪**。
 *  基准必须取在 readFileSync **之前**：快照早于读取时，读取开始之后的任何追加都会让
 *  rename 前的字节数大于快照而放弃本轮（最坏只是少裁一次）；反过来（快照取在读取之后）
 *  「read 完成、取快照之前」落进来的追加会被算进快照却不在读到的正文里——字节数相等而
 *  放行，rename 把那一行整片覆盖，事件静默丢失。按解码后的正文长度比会在文件里有非法
 *  UTF-8 时永久放弃裁剪，所以比的是 stat 的 size。
 *  取舍：持续抢写时裁剪可能长期不生效（文件停在 maxBytes 之上），换来的是绝不丢事件。
 *
 *  rename 之前那一次 stat 只能把窗口缩到「stat 之后、rename 之前」，关不死——两次系统调用
 *  之间没有原子性可用。真正兜住漏网那一行的是追加侧的 lineSurvivedFuse：rename 覆盖掉
 *  的尾部追加由追加方自己读回并补写。两侧各让一步，这条不变式才闭合。 */
function shrinkLocked(file: string, maxBytes: number): void {
  try {
    const before = statSync(file);
    if (before.size <= maxBytes) {
      return;
    }
    const snapshotBytes = before.size;
    // 权限位只取低 12 位：statSync 的 mode 含文件类型位（S_IFREG），把 0o100644 当权限
    // 传下去只是碰巧被内核掩掉，语义上不该依赖这层隐式掩码。
    // oxlint-disable-next-line eslint/no-bitwise -- 取 statSync mode 的低 12 位权限位是位掩码的本意
    const perm = before.mode & 0o7777;
    const text = readFileSync(file, "utf8");
    const shrunk = shrinkJsonlTail(text, maxBytes);
    if (shrunk === text) {
      return;
    }
    // 临时文件按持有者唯一命名：固定 `${file}.tmp` 会让两个进程在同一个临时文件上互相
    // 覆盖（A 写完 shrunk、B 覆盖成自己的、A rename —— 落盘的是谁的正文全看时序）。
    // 名字里带 pid 与随机 uuid，同一进程内的多次裁剪也不会互相踩。
    const tmp = `${file}.${newToken()}.tmp`;
    try {
      // 权限沿用原文件：writeFileSync 的 mode 会经 umask 抹位，rename 覆盖后原文件的
      // mode/属主就此丢失——流水里带着工具错误原文与路径，权限被 umask 放宽是真实的事故面。
      // chmodSync 把被 umask 抹掉的位补回（Windows 上没有权限位语义，此调用无害）。
      writeFileSync(tmp, shrunk, { mode: perm });
      try {
        chmodSync(tmp, perm);
      } catch {
        // 补位失败不阻断替换：writeFileSync 的 mode 已经覆盖了绝大多数 umask 形态。
      }
      // 乐观并发校验放在 rename **紧前**：真正会被覆盖的是「写完 tmp → rename」这段窗口
      // 里裸追加落下的行（大文件写 tmp 要几十到几百毫秒）。以前这道 stat 在写 tmp 之前，
      // 窗口被放大一个数量级。漏网的一行由追加侧 lineSurvivedFuse 兜住（三角约定见头注释）。
      if (statSync(file).size !== snapshotBytes) {
        // 快照之后有人写过：放弃本轮裁剪，删掉自己的临时文件（不留全文副本）。
        try {
          rmSync(tmp, { force: true });
        } catch {
          // 删不掉只会留下一枚带唯一名字的临时文件，不挡下一轮。
        }
        return;
      }
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
 * 为什么需要：拿不到锁的一方走裸追加，而锁的持有者可能正处在这条窗口里——它已取完快照、
 * 做过 rename 前那次 stat，我们这一行恰好落在 stat 之后、rename 之前，于是被 rename 整片
 * 覆盖（事件静默消失，而追加方已正常返回）。shrinkLocked 的那次 stat 只能把窗口缩窄，
 * 不能关死：两次系统调用之间没有原子性可用。
 *
 * 判据用「正文里是否还找得到本次写的这批字节」而不是「是否以它结尾」：我们写完之后、
 * 读回之前，任何第三方（另一进程的裸追加、或同一持有者在临界区外的追加）都可能又写了
 * 一笔，把我们的行从尾部顶掉——按结尾比对会误判成"被覆盖"而补写，流水里出现重复行。
 * 全文查找对这种情况是准确的：只要这批字节还在文件里，事件就没丢。代价是"被覆盖、
 * 但文件里恰好存在逐字节相同的另一条"会漏补——那批字节本身就是同一条事件的内容，
 * 信息没有丢失，读侧按内容去重时两条算一条。
 *
 * 仍然可能漏：我们读完、判定"在"、然后才被覆盖的那一瞬。这一层把概率压到"必须精确命中
 * 微秒级窗口"，不宣称消灭它——真正的消灭要跨进程事务，代价远高于这份派生数据的价值。
 */
function lineSurvivedFuse(file: string, payload: string): boolean {
  try {
    const text = readFileSync(file, "utf8");
    return text.includes(payload);
  } catch (error) {
    if (isEnoent(error)) {
      // 文件确实不在了（被 rename 到别处/刚才还不存在）：按"不在"处理，让调用方补写。
      return false;
    }
    // EACCES/EMFILE/ENOSPC 一类瞬态读错**不等于**这一行被覆盖：保守视为"已在"，
    // 绝不补写（补写会制造重复行，直接进阈值计数/蒸馏输入）。留一条日志便于排障。
    console.warn(
      `[lesson-loop] lesson ledger unreadable while verifying append (${errorText(error)}): ${file}`,
    );
    return true;
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
    appendFileSync(file, payload, { mode: LEDGER_FILE_MODE });
  });
  if (!locked) {
    appendFileSync(file, payload, { mode: LEDGER_FILE_MODE });
    if (!lineSurvivedFuse(file, payload)) {
      appendFileSync(file, payload, { mode: LEDGER_FILE_MODE });
    }
  }
}

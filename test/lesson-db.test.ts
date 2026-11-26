// lesson-db 单元测试：SQLite 持久层的**每条分支**都要有判据。
//
// 为什么单独立一份：这一层是"规则库 / 流水 / 台账"三块用户数据的唯一落点，读坏一行的行为
// （折空库还是报不可用）与写坏一事务的行为（回滚还是留半片）都不是 store 侧用例能覆盖的——
// 它们跑在内存里，看不到磁盘形状。这里直接用 `node:sqlite` 的另一条连接造坏行，再让端口去读，
// 期望值全部独立写死（不读被测实现的常量）。
//
// 环境前提：本机 Node 必须 ≥ engines 地板（26.13.1 实测零告警）。低于地板时 `node:sqlite`
// 会打 ExperimentalWarning，会被根噪点门禁判红——那是跑测环境的问题，不是本文件的问题。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  LESSON_DB_FILE,
  LedgerConsumedElsewhereError,
  LessonDb,
  isLedgerRow,
} from "../lib/lesson-db.ts";
import type { LessonRecord, RuleCard } from "../lib/lesson-store.ts";
import { logged, loggedText } from "./setup-logs.ts";

/** 临时目录前缀：同一字面量在四个 describe 的 beforeEach 里各出现一次。 */
const TMP_PREFIX = "lesson-db-";

/** 计数器读取与旁路实量：多处用例都要核对两者一致时共用同一条 SQL。 */
const STATS_QUERY = "SELECT total_bytes, row_count FROM lesson_stats WHERE id = 1";
const LESSON_BYTES_SUM_QUERY =
  "SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS n FROM lessons";

/** v1 台账建表期的插入语句头（造旧库夹具用，四个用例共用）。 */
const V1_LEDGER_INSERT =
  "INSERT INTO session_ledger(session_id, project, violated, passed, settled_at, updated_at) ";

/** 日志片段：多条用例都要按它们判"这条路径有没有报错"。 */
const LEDGER_READ_FAILED = "ledger read failed:";
const MIGRATION_FAILED = "rule database migration failed:";
const DB_UNAVAILABLE = "[lesson-loop] rule database unavailable:";

const t0 = 1_700_000_000_000;

/** 本条文件打开过的连接：afterEach 必须先 close 再删目录。
 *  Windows 上仍打开的 SQLite 连接锁着库文件与 WAL/SHM，`rmSync` 会报 EPERM；
 *  宿主的真实卸载路径会 close，但单元测试直接拿到的句柄必须由测试自己归还。 */
const openedDbs: LessonDb[] = [];

/** 打开并登记连接；open 失败返回 null 时没有句柄可登记。 */
function openDb(options: Parameters<typeof LessonDb.open>[0]): LessonDb | null {
  const db = LessonDb.open(options);
  if (db !== null) {
    openedDbs.push(db);
  }
  return db;
}

/** 关闭本条用例打开的全部连接；close 幂等，用例内已手动关闭的再关一次无副作用。 */
function closeOpenedDbs(): void {
  for (const db of openedDbs.splice(0)) {
    db.close();
  }
}

/** 一张最简规则卡（只覆盖差异项）。 */
function card(over: Partial<RuleCard> = {}): RuleCard {
  return {
    id: "r1",
    project: "p",
    category: "gate-failure",
    signature: "sig",
    statement: "陈述",
    status: "armed",
    createdAt: t0,
    updatedAt: t0,
    armedAt: t0,
    occurrences: 1,
    sources: [],
    violation: 0,
    suppressed: 0,
    samples: 0,
    recurrences: 0,
    evidence: [],
    origin: "threshold",
    ...over,
  };
}

/** 一条最简教训。 */
function lesson(over: Partial<LessonRecord> = {}): LessonRecord {
  return {
    ts: t0,
    source: "quality-gate",
    category: "gate-failure",
    project: "p",
    signature: "sig",
    detail: "exit=1",
    ...over,
  };
}

/** 直接开一条旁路连接：造坏行 / 造缺表，专用。 */
const rawDbs: DatabaseSync[] = [];

function raw(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  rawDbs.push(db);
  return db;
}

/** 关闭本条用例打开的全部旁路连接；用例内已手动关闭的再关一次会抛，吞掉即可。 */
function closeRawDbs(): void {
  for (const db of rawDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // 已手动关闭：没有剩余句柄可还。
    }
  }
}

/** 用旁路连接跑一句 SQL 就关（不长期持有第二条连接）。 */
function sideWrite(file: string, sql: string): void {
  const side = raw(file);
  side.exec(sql);
  side.close();
}

describe("open 的失败面", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("路径被目录占住时 open 返回 null 并点名（装载期一次磁盘故障不许抛穿）", () => {
    // 把"库文件"路径做成目录：DatabaseSync 打不开一个目录。
    const file = path.join(dir, "nested", LESSON_DB_FILE);
    mkdirSync(file, { recursive: true });

    expect(openDb({ path: file })).toBeNull();
    expect(loggedText()).toContain(DB_UNAVAILABLE);
    expect(logged()).toHaveLength(1);
  });

  it("库里不是 SQLite → open 返回 null 并关掉刚打开的连接（不让坏库句柄漏到回退路径）", () => {
    const file = path.join(dir, "nested", LESSON_DB_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not a sqlite database", "utf8");

    expect(openDb({ path: file })).toBeNull();
    expect(loggedText()).toContain(DB_UNAVAILABLE);
    expect(logged()).toHaveLength(1);
  });

  it("open 失败后的关闭也失败 → 两条日志都只记不抛，句柄仍被真正关掉", () => {
    const file = path.join(dir, "nested", LESSON_DB_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not a sqlite database", "utf8");
    const closeDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close");
    if (closeDescriptor === undefined || typeof closeDescriptor.value !== "function") {
      throw new Error("DatabaseSync.prototype.close 不可用");
    }
    const realClose = closeDescriptor.value as (this: DatabaseSync) => void;
    const closeSpy = vi
      .spyOn(DatabaseSync.prototype, "close")
      .mockImplementation(function closeThenThrow(this: DatabaseSync): void {
        // 先真的关掉，再模拟关闭失败：这样用例结束时 Windows 也能删掉临时目录。
        realClose.call(this);
        throw new Error("关闭炸了");
      });
    try {
      expect(openDb({ path: file })).toBeNull();
    } finally {
      closeSpy.mockRestore();
    }
    expect(loggedText()).toContain("rule database close failed:");
    expect(loggedText()).toContain("关闭炸了");
    expect(loggedText()).toContain(DB_UNAVAILABLE);
  });

  it("新库：建表 + meta 两键 + revision 0；再开一次不重置（INSERT OR IGNORE 幂等）", () => {
    const file = path.join(dir, "nested", LESSON_DB_FILE);
    const db = openDb({ path: file });
    expect(db).not.toBeNull();
    expect(db?.revision()).toBe(0);
    expect(db?.rulesCount()).toBe(0);
    expect(db?.lessonsCount()).toBe(0);

    const again = openDb({ path: file });
    expect(again?.revision()).toBe(0);
    expect(logged()).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("新库文件在 POSIX 上收紧到 0600", () => {
    const file = path.join(dir, "nested", LESSON_DB_FILE);
    openDb({ path: file })?.close();
    // statSync 的 mode 低 12 位是权限位；取低 10 位避免 bitwise 规则。
    expect(statSync(file).mode % 0o1000).toBe(0o600);
  });

  it("meta.revision 坏值/缺行都回落 0（多一次冲突重放也只是重放）", () => {
    const file = path.join(dir, LESSON_DB_FILE);
    const db = openDb({ path: file, now: () => t0 });
    expect(db).not.toBeNull();

    const side = raw(file);
    side.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run("not-a-number");
    expect(db?.revision()).toBe(0);

    side.prepare("DELETE FROM meta WHERE key = 'revision'").run();
    expect(db?.revision()).toBe(0);
    side.close();
  });
});

describe("规则库端口：读坏行的三种形态都退 usable:false", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
    file = path.join(dir, LESSON_DB_FILE);
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("空库读：usable:true + revision 0 + 零卡", () => {
    const db = openDb({ path: file });
    expect(db?.rules.load()).toStrictEqual({ revision: 0, cards: [], usable: true });
  });

  it("库里的 JSON 坏了 → usable:false（不折成空库，避免下一次写整片覆盖坏数据背书）", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side
      .prepare(
        "INSERT INTO rules(id, project, status, updated_at, payload) VALUES('r1','p','armed',0,'{')",
      )
      .run();
    expect(db?.rules.load()).toStrictEqual({ revision: -1, cards: [], usable: false });
    expect(loggedText()).toContain("rule library unreadable: malformed payload");
  });

  it("库里的 JSON 合法但不是规则卡 → usable:false", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side
      .prepare(
        "INSERT INTO rules(id, project, status, updated_at, payload) VALUES('r1','p','armed',0,'{\"foo\":1}')",
      )
      .run();
    expect(db?.rules.load().usable).toBe(false);
    expect(loggedText()).toContain("rule library unreadable: row is not a rule card");
  });

  it("payload 不是文本（BLOB）→ usable:false", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    // BLOB 的 JS 读回是 Uint8Array，typeof 不是 string：TEXT 亲和性不会把它转成文本。
    side
      .prepare(
        "INSERT INTO rules(id, project, status, updated_at, payload) VALUES('r1','p','armed',0,CAST(x'00' AS BLOB))",
      )
      .run();
    expect(db?.rules.load().usable).toBe(false);
    expect(loggedText()).toContain("rule library unreadable: non-text payload");
  });

  it("表被删 → 读失败也退 usable:false（catch 分支）", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side.exec("DROP TABLE rules");
    expect(db?.rules.load().usable).toBe(false);
    expect(loggedText()).toContain("rule read failed:");
    side.close();
  });
});

describe("规则库端口：带 revision 的整片写", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
    file = path.join(dir, LESSON_DB_FILE);
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("不可用 revision（负数/小数/NaN）一律 rejected，且不碰库", async () => {
    const db = openDb({ path: file });
    if (db === null) {
      throw new Error("库没打开：本用例的前提是路径可写");
    }
    const outcomes = await Promise.all(
      [-1, 1.5, Number.NaN].map((revision) => db.rules.save([card()], revision)),
    );
    expect(outcomes).toStrictEqual(["rejected", "rejected", "rejected"]);
    expect(db.rulesCount()).toBe(0);
    expect(db.revision()).toBe(0);
    expect(loggedText()).toContain("rules write refused:");
  });

  it("首写：逐卡 upsert + revision+1；读回的卡与写进去的逐字段相同", async () => {
    const db = openDb({ path: file, now: () => t0 });
    const write = await db?.rules.save([card(), card({ id: "r2", status: "candidate" })], 0);
    expect(write).toBe("persisted");
    expect(db?.rulesCount()).toBe(2);
    expect(db?.revision()).toBe(1);

    const read = db?.rules.load();
    expect(read?.usable).toBe(true);
    expect(read?.revision).toBe(1);
    expect(read?.cards.map((row) => row.id).toSorted()).toStrictEqual(["r1", "r2"]);
  });

  it("二写：同 id 覆盖，消失的卡被删（合并迁移会丢源卡），revision 继续单调", async () => {
    const db = openDb({ path: file, now: () => t0 });
    await db?.rules.save([card(), card({ id: "r2" })], 0);
    const outcome = await db?.rules.save([card({ id: "r1", occurrences: 9 })], 1);
    expect(outcome).toBe("persisted");
    expect(db?.rulesCount()).toBe(1);
    expect(db?.rules.load().cards[0]?.occurrences).toBe(9);
    expect(db?.revision()).toBe(2);
  });

  it("revision 陈旧 → conflict，一行都不写（重读重放交给 store）", async () => {
    const db = openDb({ path: file });
    await db?.rules.save([card()], 0);
    const outcome = await db?.rules.save([card({ id: "r3" })], 0);
    expect(outcome).toBe("conflict");
    expect(db?.rulesCount()).toBe(1);
    expect(db?.revision()).toBe(1);
  });

  it("事务里抛错（BigInt 序列化不了）→ 回滚 + rejected，revision 不动", async () => {
    const db = openDb({ path: file });
    await db?.rules.save([card()], 0);
    // JSON.stringify 遇 BigInt 抛 TypeError：位置在 BEGIN IMMEDIATE 之后，必然会走到回滚。
    const poison = card({ id: "poison", occurrences: 10n as unknown as number });
    const outcome = await db?.rules.save([card(), poison], 1);
    expect(outcome).toBe("rejected");
    expect(db?.rulesCount()).toBe(1);
    expect(db?.revision()).toBe(1);
    expect(loggedText()).toContain("rules write failed:");
  });

  it("事务 BEGIN 之前就失败（库被外部关掉/表不存在）走 catch，回滚失败只吞掉", async () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side.exec("DROP TABLE meta");
    side.exec("DROP TABLE rules");
    const outcome = await db?.rules.save([card()], 0);
    expect(outcome).toBe("rejected");
    expect(loggedText()).toContain("rules write failed:");
    side.close();
  });
});

describe("流水端口：追加 / 读取 / 保险丝", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
    file = path.join(dir, LESSON_DB_FILE);
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("追加两条：全量读、按 project 读、limit 取尾部、count 同步", () => {
    const db = openDb({ path: file });
    // 空批次是迁移的合法前置（文件里一条都归一不出来时调用方会先拦，但 API 本身仍应返回 0）。
    expect(db?.importLessons([])).toBe(0);
    db?.lessons.append(lesson({ signature: "a", project: "p1" }), 0);
    db?.lessons.append(lesson({ signature: "b", project: "p2" }), 0);
    db?.lessons.append(lesson({ signature: "c", project: "p1" }), 0);

    expect(db?.lessons.count()).toBe(3);
    expect(db?.lessons.recent().map((row) => row.signature)).toStrictEqual(["a", "b", "c"]);
    expect(db?.lessons.recent("p1").map((row) => row.signature)).toStrictEqual(["a", "c"]);
    expect(db?.lessons.recent(undefined, 2).map((row) => row.signature)).toStrictEqual(["b", "c"]);
  });

  it("maxBytes 保险丝：超限从最旧删起，未超限与 0（不设限）一个字都不删", () => {
    const db = openDb({ path: file });
    const big = lesson({ signature: "old", detail: "x".repeat(2000) });
    db?.lessons.append(big, 0);
    db?.lessons.append(lesson({ signature: "new", detail: "small" }), 0);
    expect(db?.lessons.count()).toBe(2);

    // 1KB 上限：2000 字符的老行必须被裁掉，新的留下。
    db?.lessons.append(lesson({ signature: "trigger", detail: "tiny" }), 1024);
    expect(db?.lessons.count()).toBe(2);
    expect(db?.lessons.recent().map((row) => row.signature)).toStrictEqual(["new", "trigger"]);
  });

  it("maxBytes 按 UTF-8 字节裁剪：中文 payload 不会被字符口径放大三倍", () => {
    const db = openDb({ path: file });
    // 1000 个汉字 ≈ 3000 字节；旧实现按 LENGTH(TEXT) 只算 1000 字符，2000 上限会把它留下。
    const big = lesson({ signature: "big-zh", detail: "汉".repeat(1000) });
    db?.lessons.append(big, 2000);
    expect(db?.lessons.count()).toBe(1);
    db?.lessons.append(lesson({ signature: "small", detail: "x" }), 2000);
    expect(db?.lessons.count()).toBe(1);
    expect(db?.lessons.recent().map((row) => row.signature)).toStrictEqual(["small"]);
    expect(Buffer.byteLength(JSON.stringify(big), "utf8")).toBeGreaterThan(2000);
  });

  it("lesson_stats 随插入/删除维护，裁剪只读这一行而不每次 SUM 全表", () => {
    const db = openDb({ path: file });
    db?.lessons.append(lesson({ signature: "a", detail: "甲" }), 0);
    db?.lessons.append(lesson({ signature: "b", detail: "乙" }), 0);

    const side = raw(file);
    const inspect = (): { bytes: number; rows: number; sum: number; count: number } => {
      const stats = side.prepare(STATS_QUERY).get();
      const sum = side.prepare(LESSON_BYTES_SUM_QUERY).get();
      return {
        bytes: typeof stats?.["total_bytes"] === "number" ? stats["total_bytes"] : -1,
        rows: typeof stats?.["row_count"] === "number" ? stats["row_count"] : -1,
        sum: typeof sum?.["n"] === "number" ? sum["n"] : -1,
        count: 2,
      };
    };
    const before = inspect();
    expect(before).toStrictEqual({ bytes: before.sum, rows: 2, sum: before.sum, count: 2 });

    // 旁路连接的写入也必须经过触发器：否则别的进程/诊断脚本一改，计数器就悄悄漂移。
    side
      .prepare("INSERT INTO lessons(ts, project, session_id, payload) VALUES(0, 'p', NULL, ?)")
      .run(JSON.stringify(lesson({ signature: "side" })));
    const afterInsert = inspect();
    expect(afterInsert).toStrictEqual({
      bytes: afterInsert.sum,
      rows: 3,
      sum: afterInsert.sum,
      count: 2,
    });

    side.prepare("DELETE FROM lessons WHERE id = (SELECT MIN(id) FROM lessons)").run();
    const afterDelete = inspect();
    expect(afterDelete).toStrictEqual({
      bytes: afterDelete.sum,
      rows: 2,
      sum: afterDelete.sum,
      count: 2,
    });
    side.close();
  });

  it("裁剪超过 256 条时按主键分批继续，直到字节回到上限以内", () => {
    const db = openDb({ path: file });
    for (let index = 0; index < 300; index += 1) {
      db?.lessons.append(lesson({ signature: `old-${String(index)}`, detail: "x".repeat(100) }), 0);
    }
    expect(db?.lessons.count()).toBe(300);
    db?.lessons.append(lesson({ signature: "latest", detail: "y".repeat(100) }), 10_000);

    const count = db?.lessons.count() ?? 0;
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThan(300);
    expect(db?.lessons.recent().at(-1)?.signature).toBe("latest");
    const side = raw(file);
    const stats = side.prepare(STATS_QUERY).get();
    const sum = side.prepare(LESSON_BYTES_SUM_QUERY).get();
    side.close();
    expect(stats?.["row_count"]).toBe(count);
    expect(stats?.["total_bytes"]).toBe(sum?.["n"]);
    expect(stats?.["total_bytes"]).toBeLessThanOrEqual(10_000);
  });

  it("计数器行被外部删除时，append 的裁剪按实量重建而不是阻断写入", () => {
    const db = openDb({ path: file });
    db?.lessons.append(lesson({ signature: "a", detail: "甲" }), 0);
    db?.lessons.append(lesson({ signature: "b", detail: "乙" }), 0);
    const side = raw(file);
    side.exec("DELETE FROM lesson_stats");
    side.close();

    // maxBytes > 0 会进 trimLessons；它读不到计数器行时必须按 lessons 实量重建。
    db?.lessons.append(lesson({ signature: "c", detail: "丙" }), 1_000_000);
    expect(db?.lessons.count()).toBe(3);
    const side2 = raw(file);
    const stats = side2.prepare(STATS_QUERY).get();
    const sum = side2.prepare(LESSON_BYTES_SUM_QUERY).get();
    side2.close();
    expect(stats?.["row_count"]).toBe(3);
    expect(stats?.["total_bytes"]).toBe(sum?.["n"]);
  });

  it("裁剪失败（删除触发器拒绝）时，已提交的新教训仍进入下一次读缓存", () => {
    const db = openDb({ path: file });
    db?.lessons.append(lesson({ signature: "blocked", detail: "block-trim".repeat(20) }), 0);
    db?.lessons.append(lesson({ signature: "kept", detail: "keep" }), 0);
    expect(db?.lessons.count()).toBe(2);

    const side = raw(file);
    side.exec(`
      CREATE TRIGGER reject_trim BEFORE DELETE ON lessons
      WHEN OLD.payload LIKE '%block-trim%'
      BEGIN
        SELECT RAISE(ABORT, 'blocked trim');
      END;
    `);
    expect(() =>
      db?.lessons.append(lesson({ signature: "fresh", detail: "f" }), 100),
    ).not.toThrow();
    // 插入已提交，裁剪回滚：读缓存必须按已提交的 3 条重建，而不是停在插入前的 2 条。
    expect(db?.lessons.count()).toBe(3);
    expect(db?.lessons.recent().map((row) => row.signature)).toStrictEqual([
      "blocked",
      "kept",
      "fresh",
    ]);
    expect(loggedText()).toContain("lesson append failed:");
    side.close();
  });

  it("importLessons 传入内存 seen 时按 payload 去重，失败回滚不污染 seen", () => {
    const db = openDb({ path: file });
    db?.lessons.append(lesson({ signature: "existing" }), 0);
    const seen = db?.lessonPayloads() ?? new Set<string>();
    const existingPayload = JSON.stringify(lesson({ signature: "existing" }));
    expect(seen.has(existingPayload)).toBe(true);

    const count = db?.importLessons(
      [
        lesson({ signature: "existing" }),
        lesson({ signature: "new" }),
        lesson({ signature: "new" }),
      ],
      0,
      undefined,
      seen,
    );
    expect(count).toBe(3);
    expect(db?.lessons.count()).toBe(2);
    const newPayload = JSON.stringify(lesson({ signature: "new" }));
    expect(seen.has(newPayload)).toBe(true);

    const side = raw(file);
    side.exec(`
      CREATE TRIGGER reject_import BEFORE INSERT ON lessons
      WHEN NEW.payload LIKE '%reject-import%'
      BEGIN
        SELECT RAISE(ABORT, 'reject import');
      END;
    `);
    side.close();
    const seenBeforeFailure = db?.lessonPayloads() ?? new Set<string>();
    expect(
      db?.importLessons(
        [lesson({ signature: "would-be-valid" }), lesson({ signature: "reject-import" })],
        0,
        undefined,
        seenBeforeFailure,
      ),
    ).toBe(0);
    const validPayload = JSON.stringify(lesson({ signature: "would-be-valid" }));
    expect(seenBeforeFailure.has(validPayload)).toBe(false);
  });

  it("lessonPayloads 只收文本 payload：旁路写入的 BLOB 不进入迁移去重集合", () => {
    const db = openDb({ path: file });
    db?.lessons.append(lesson({ signature: "text" }), 0);
    const side = raw(file);
    side
      .prepare(
        "INSERT INTO lessons(ts, project, session_id, payload) VALUES(0, 'p', NULL, CAST(x'00' AS BLOB))",
      )
      .run();
    side.close();
    const payloads = db?.lessonPayloads() ?? new Set<string>();
    const textPayload = JSON.stringify(lesson({ signature: "text" }));
    expect(payloads.has(textPayload)).toBe(true);
    expect(payloads.size).toBe(1);
  });

  it("importLessons 缺省 seen 时仍按 payload SQL 去重（旧 API 语义不回退成重复插入）", () => {
    const db = openDb({ path: file });
    const legacySignature = "legacy-existing";
    db?.lessons.append(lesson({ signature: legacySignature }), 0);
    expect(db?.importLessons([lesson({ signature: legacySignature })])).toBe(1);
    expect(db?.lessons.count()).toBe(1);
    expect(db?.importLessons([lesson({ signature: legacySignature })])).toBe(1);
    expect(db?.lessons.count()).toBe(1);
  });

  it("readLessons 跳过坏行：非文本 / 坏 JSON / 归一失败三种都不许把整条读途炸掉", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    const insert = side.prepare(
      "INSERT INTO lessons(ts, project, session_id, payload) VALUES(0, 'p', NULL, ?)",
    );
    insert.run("not json");
    insert.run("null");
    insert.run(JSON.stringify({ category: 1, signature: "s" }));
    insert.run(JSON.stringify(lesson({ signature: "good" })));
    side.close();

    const rows = db?.lessons.recent();
    expect(rows?.map((row) => row.signature)).toStrictEqual(["good"]);
    // 计数必须复用读侧归一：raw COUNT(*) 会给出 4，界面计数就会大于列表长度；
    // 迁移也会因为一行坏数据把整条旧流水当成"库已有流水"而永久跳过。
    expect(db?.lessonsCount()).toBe(1);
    expect(db?.lessons.count()).toBe(1);
  });

  it("读侧跳过非文本 payload（BLOB）：与坏 JSON 同一处理", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side
      .prepare(
        "INSERT INTO lessons(ts, project, session_id, payload) VALUES(0, 'p', NULL, CAST(x'00' AS BLOB))",
      )
      .run();
    side.close();
    expect(db?.lessons.recent()).toStrictEqual([]);
  });

  it("追加失败只日志（表被删）：热路径不许抛穿", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side.exec("DROP TABLE lessons");
    side.close();

    expect(() => db?.lessons.append(lesson(), 0)).not.toThrow();
    expect(loggedText()).toContain("lesson append failed:");
  });
});

describe("会话台账端口", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
    file = path.join(dir, LESSON_DB_FILE);
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("计数写穿透：同会话同项目累加成一行，未落定的才被补算读到", () => {
    const db = openDb({ path: file, now: () => t0 });
    db?.noteLedger("s1", "p", "violated", "r1");
    db?.noteLedger("s1", "p", "passed", "r2");
    db?.noteLedger("s1", "p", "violated", "r1");

    const pending = db?.pendingLedger("s1") ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.violated).toStrictEqual(["r1"]);
    expect(pending[0]?.passed).toStrictEqual(["r2"]);

    db?.settleLedgerNow("s1", "p", { violated: ["r1"], passed: ["r2"] }, true);
    expect(db?.pendingLedger("s1")).toStrictEqual([]);
  });

  it("台账行的 JSON 列坏了只折空数组（坏一行不该让整场会话清不了算）", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side.prepare(`${V1_LEDGER_INSERT}VALUES('s1', 'p', 'not json', '[1,"keep",2]', NULL, 0)`).run();
    side.close();

    const row = db?.pendingLedger("s1")[0];
    expect(row?.violated).toStrictEqual([]);
    expect(row?.passed).toStrictEqual(["keep"]);

    // JSON 合法但不是数组：同样折空（不是"把对象当字符串数组用"）。
    sideWrite(file, "UPDATE session_ledger SET violated = '\"str\"' WHERE session_id = 's1'");
    expect(db?.pendingLedger("s1")[0]?.violated).toStrictEqual([]);
  });

  it("project 不是文本的台账行被跳过（列可能被外部写成 BLOB）", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side.prepare(`${V1_LEDGER_INSERT}VALUES('s1', CAST(x'00' AS BLOB), '[]', '[]', NULL, 0)`).run();
    side.close();

    expect(db?.pendingLedger("s1")).toStrictEqual([]);
  });

  it("表被删：计数与读面降级，落定**故意抛穿**（好让规则写事务整笔回滚）", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side.exec("DROP TABLE session_ledger");
    side.close();

    expect(() => db?.noteLedger("s1", "p", "violated", "r1")).not.toThrow();
    // 落定这一笔与规则计数在**同一个事务**里（host 侧把它当 saveRules 的 onPersisted）：
    // 吞掉这个错就等于让规则库前进、台账原地不动，下一轮补算会把同一笔再计一次。
    // 所以这里必须抛，由 host.ts 的 `ledger settle failed:` 那一支接住并让整笔回滚。
    expect(() => db?.settleLedgerNow("s1", "p", { violated: ["r1"], passed: [] }, true)).toThrow(
      /no such table: session_ledger/u,
    );
    // 读面同样要降级成空数组，而不是把 SQL 错误抛给清算/补算路径。
    expect(db?.pendingLedger("s1")).toStrictEqual([]);
    expect(db?.pendingLedgerAll()).toStrictEqual([]);
    expect(loggedText()).toContain("ledger write failed:");
    expect(loggedText()).toContain(LEDGER_READ_FAILED);
  });

  it("isLedgerRow 只认 sessionId + project 两个可读字段", () => {
    expect(isLedgerRow({ sessionId: "s", project: "p" })).toBe(true);
    expect(isLedgerRow({ sessionId: "s" })).toBe(false);
    expect(isLedgerRow({ sessionId: 1, project: "p" })).toBe(false);
    expect(isLedgerRow(null)).toBe(false);
  });

  it("行不存在且 expected 非空 → 新建空行落定，不把 noteLedger 写失败误判成已消费", () => {
    const db = openDb({ path: file, now: () => t0 });
    // 模拟 noteLedger 在内存桶记账之后写失败：库里没有这一场的行，但 expected 有 id。
    // 行不存在意味着“没排过队”，不是“已被别处取走”，必须允许新建空行结清。
    expect(() =>
      db?.settleLedgerNow("s1", "p", { violated: ["r1"], passed: [] }, true),
    ).not.toThrow();
    const row = db?.ledgerRow("s1", "p");
    expect(row?.violated).toStrictEqual([]);
    expect(row?.settledAt).not.toBeNull();
    expect(row?.exposureAt).not.toBeNull();
    expect(db?.pendingLedger("s1")).toStrictEqual([]);
    expect(db?.ledgerRow("s1", "missing")).toBeNull();
  });

  it("队列里没有的那笔再落定 → 抛 LedgerConsumedElsewhereError（别处已计，重复计两遍）", () => {
    const db = openDb({ path: file, now: () => t0 });
    db?.noteLedger("s1", "p", "violated", "r1");
    // 另一条连接先把 r1 取走：本连接看到的队列已经不含它。
    const other = openDb({ path: file, now: () => t0 });
    other?.settleLedgerNow("s1", "p", { violated: ["r1"], passed: [] }, true);
    other?.close();

    expect(() => db?.settleLedgerNow("s1", "p", { violated: ["r1"], passed: [] }, true)).toThrow(
      LedgerConsumedElsewhereError,
    );
    expect(() => db?.settleLedgerNow("s1", "p", { violated: ["r1"], passed: [] }, true)).toThrow(
      /ledger row already consumed: s1 \/ p/u,
    );
  });

  it("只取走队列的一部分 → 队列不清空，settled_at 沿用上一轮的时间戳", () => {
    const db = openDb({ path: file, now: () => t0 });
    db?.noteLedger("s1", "p", "violated", "r1");
    db?.noteLedger("s1", "p", "violated", "r2");
    // 先只取 r1：队列还剩 r2，这次结算不该把整行标成"已落定"。
    db?.settleLedgerNow("s1", "p", { violated: ["r1"], passed: [] }, true);
    const [partial] = db?.pendingLedger("s1") ?? [];
    expect(partial?.violated).toStrictEqual(["r2"]);
    expect(partial?.settledAt).toBeNull();

    db?.settleLedgerNow("s1", "p", { violated: ["r2"], passed: [] }, true);
    expect(db?.pendingLedger("s1")).toStrictEqual([]);
    const side = raw(file);
    const [row] = side
      .prepare("SELECT settled_at, exposure_at FROM session_ledger WHERE session_id = 's1'")
      .all();
    side.close();
    expect(row?.["settled_at"]).toBe(t0);
    // 暴露度只记第一次：第二次结算（countExposure 仍为真）不再改写它。
    expect(row?.["exposure_at"]).toBe(t0);
  });

  it("台账行带数字时间戳时原样读出（列是动态类型，别把数字读成 null）", () => {
    const db = openDb({ path: file, now: () => t0 });
    db?.noteLedger("s1", "p", "violated", "r1");
    sideWrite(
      file,
      "UPDATE session_ledger SET settled_at = 123, exposure_at = 456 WHERE session_id = 's1'",
    );
    const [row] = db?.pendingLedgerAll() ?? [];
    expect(row?.settledAt).toBe(123);
    expect(row?.exposureAt).toBe(456);
  });
});

describe("连接生命周期：关闭幂等、关闭后拒写、读面降级", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
    file = path.join(dir, LESSON_DB_FILE);
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("close 幂等：第二次调用直接返回，不再碰底层连接", () => {
    const db = openDb({ path: file });
    db?.close();
    expect(() => db?.close()).not.toThrow();
    expect(logged()).toHaveLength(0);
  });

  it("底层关闭失败只日志（卸载路径不许把错抛给宿主）", () => {
    const db = openDb({ path: file });
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(() => {
      throw new Error("关闭炸了");
    });
    try {
      expect(() => db?.close()).not.toThrow();
    } finally {
      closeSpy.mockRestore();
    }
    expect(loggedText()).toContain("rule database close failed:");
    expect(loggedText()).toContain("关闭炸了");
    // close 失败不能把 closed 永久钉死：恢复真实实现后仍必须能关掉句柄，
    // 否则 Windows 上这条用例自己的临时目录就删不掉（也会污染宿主卸载路径）。
    expect(() => db?.close()).not.toThrow();
  });

  it("关闭后写 → rejected 并点名；教训计数与台账读面降级成 0 / 空数组", () => {
    const db = openDb({ path: file });
    db?.close();

    expect(db?.saveRulesNow([card()], 0)).toBe("rejected");
    expect(loggedText()).toContain("rules write refused: database is closed");
    expect(db?.lessonsCount()).toBe(0);
    expect(loggedText()).toContain("lesson count failed:");
    expect(db?.pendingLedgerAll()).toStrictEqual([]);
    expect(loggedText()).toContain(LEDGER_READ_FAILED);
  });

  it("教训表被删 → 计数降级成 0（卡片少个数字好过整张报错），hasLessons 仍抛出", () => {
    const db = openDb({ path: file });
    const side = raw(file);
    side.exec("DROP TABLE lessons");
    side.close();

    expect(db?.lessonsCount()).toBe(0);
    expect(loggedText()).toContain("lesson count failed:");
    expect(loggedText()).toContain("no such table: lessons");
    // 迁移守卫必须拿到"未知"，不能拿到"空库"——否则整份旧 events.jsonl 会被重导一遍。
    expect(() => db?.hasLessons()).toThrow(/no such table: lessons/u);
  });
});

describe("结构升级：v1 库就地升到 v2", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
    file = path.join(dir, LESSON_DB_FILE);
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /**
   * 造一份 v1 形状的库：台账没有 `exposure_at` 列、两个数组是"累计违过/过哪些"（落定后不清空）。
   * `withExposure` 用来造"已经有这一列"的变体（有些人从中间版本升上来）。
   */
  function writeV1(withExposure: boolean): void {
    const side = raw(file);
    side.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE rules (id TEXT PRIMARY KEY, project TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, project TEXT NOT NULL, session_id TEXT, payload TEXT NOT NULL);
      CREATE TABLE session_ledger (session_id TEXT NOT NULL, project TEXT NOT NULL, violated TEXT NOT NULL, passed TEXT NOT NULL, settled_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, project));
    `);
    if (withExposure) {
      side.exec("ALTER TABLE session_ledger ADD COLUMN exposure_at INTEGER");
    }
    side
      .prepare("INSERT INTO meta(key, value) VALUES('schema_version', '1'), ('revision', '0')")
      .run();
    // 已落定的旧行：按 v1 语义数组不清空，升级必须把它们清掉，否则第一次补算重算历史。
    side.prepare(`${V1_LEDGER_INSERT}VALUES('settled', 'p', '["a"]', '["b"]', 111, 0)`).run();
    // 未落定的旧行：数组就是待计队列，升级必须原样保留。
    side.prepare(`${V1_LEDGER_INSERT}VALUES('open', 'p', '["x"]', '[]', NULL, 0)`).run();
    side.close();
  }

  it("缺 exposure_at → 补列 + 清空已落定行的队列 + schema_version 追平到 2", () => {
    writeV1(false);
    const db = openDb({ path: file, now: () => t0 });
    expect(db).not.toBeNull();
    expect(loggedText()).not.toContain(MIGRATION_FAILED);

    // 已落定那行升级后队列为空：`pendingLedger` 因此不再返回它（settled_at 非空且队列空），
    // 直接读库确认"数组被清空、时间戳保留、新列补上"这三件事。
    expect(db?.pendingLedger("settled")).toStrictEqual([]);
    expect(db?.pendingLedgerAll().map((row) => row.sessionId)).toStrictEqual(["open"]);
    expect(db?.pendingLedger("open")[0]?.violated).toStrictEqual(["x"]);

    const side = raw(file);
    const [row] = side.prepare("SELECT value FROM meta WHERE key = 'schema_version'").all();
    const columns = side.prepare("PRAGMA table_info(session_ledger)").all();
    const [settled] = side
      .prepare(
        "SELECT violated, passed, settled_at FROM session_ledger WHERE session_id = 'settled'",
      )
      .all();
    side.close();
    expect(row?.["value"]).toBe("2");
    expect(columns.map((column) => column["name"])).toContain("exposure_at");
    expect(settled?.["violated"]).toBe("[]");
    expect(settled?.["passed"]).toBe("[]");
    expect(settled?.["settled_at"]).toBe(111);
  });

  it("已有 exposure_at 的中间版本 → 不重复 ALTER，仍清空已落定行", () => {
    writeV1(true);
    const db = openDb({ path: file, now: () => t0 });
    expect(db).not.toBeNull();
    expect(loggedText()).not.toContain(MIGRATION_FAILED);
    expect(db?.pendingLedger("settled")).toStrictEqual([]);
    expect(db?.pendingLedgerAll().map((row) => row.sessionId)).toStrictEqual(["open"]);

    const side = raw(file);
    const [settled] = side
      .prepare("SELECT violated, passed FROM session_ledger WHERE session_id = 'settled'")
      .all();
    side.close();
    expect(settled?.["violated"]).toBe("[]");
    expect(settled?.["passed"]).toBe("[]");
  });

  it("v2 库再开一次不再跑升级（schema_version 已是当期的早退支）", () => {
    writeV1(false);
    const first = openDb({ path: file });
    expect(first?.pendingLedgerAll().map((row) => row.sessionId)).toStrictEqual(["open"]);
    first?.close();
    const second = openDb({ path: file });
    expect(second).not.toBeNull();
    expect(loggedText()).not.toContain(MIGRATION_FAILED);
    // 第二次开库不再升级：未落定的那行原样（若又跑一次升级，它也会被清空）。
    expect(second?.pendingLedgerAll().map((row) => row.sessionId)).toStrictEqual(["open"]);
  });

  it("升级中途失败 → 回滚 + 只日志，库仍按旧形状可用（不许让插件装不上）", () => {
    writeV1(false);
    // 让 UPDATE 那一句被触发器拒掉：ALTER 已经跑过，回滚必须把列也一起退回去。
    const side = raw(file);
    side.exec(`
      CREATE TRIGGER reject_ledger_update BEFORE UPDATE ON session_ledger
      BEGIN
        SELECT RAISE(ABORT, 'migration test abort');
      END;
    `);
    side.close();

    const db = openDb({ path: file, now: () => t0 });
    expect(db).not.toBeNull();
    expect(loggedText()).toContain(MIGRATION_FAILED);
    expect(loggedText()).toContain("migration test abort");
    // 回滚之后没有半截结构：列没加、版本号还是 1、旧行原样。
    const check = raw(file);
    const columns = check.prepare("PRAGMA table_info(session_ledger)").all();
    const [version] = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").all();
    check.close();
    expect(columns.map((column) => column["name"])).not.toContain("exposure_at");
    expect(version?.["value"]).toBe("1");
    // 降级态仍要能读台账：读语句按"没有 exposure_at 列"的形状拼（否则整条台账报 no such column）。
    // 旧行因此仍是 v1 语义（数组是累计集合、落定后不清空），这正是"少一层去重"的已知代价。
    expect(loggedText()).not.toContain(LEDGER_READ_FAILED);
    const pending = db?.pendingLedgerAll() ?? [];
    expect(pending.map((row) => row.sessionId)).toStrictEqual(["open", "settled"]);
    expect(pending.find((row) => row.sessionId === "settled")?.violated).toStrictEqual(["a"]);
    expect(pending.every((row) => row.exposureAt === null)).toBe(true);

    // 写面同样降级：记一笔仍然可用，暴露度那一列不写。
    db?.noteLedger("late", "p", "violated", "r9");
    expect(db?.pendingLedgerAll().map((row) => row.sessionId)).toStrictEqual([
      "late",
      "open",
      "settled",
    ]);
    expect(db?.pendingLedgerAll()[0]?.exposureAt).toBeNull();
    expect(loggedText()).not.toContain("ledger write failed:");

    // 结清也要降级：SQL 少一列，否则降级态上结算一笔就抛 no such column。
    // 用一个新的 (会话,项目) 走 INSERT 支——UPDATE 支被上面那条 ABORT 触发器挡着，那是本
    // 用例用来造"升级失败"的夹具，不能拿它验证降级写面。
    expect(() =>
      db?.settleLedgerNow("fresh", "p", { violated: [], passed: [] }, true),
    ).not.toThrow();
    expect(db?.pendingLedgerAll().map((row) => row.sessionId)).toStrictEqual([
      "late",
      "open",
      "settled",
    ]);
  });
});

describe("meta.revision 自愈", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
    file = path.join(dir, LESSON_DB_FILE);
  });

  afterEach(() => {
    closeRawDbs();
    closeOpenedDbs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("坏值（小数/负数/非数）读时归零并落库，之后能正常写（不再永久只读）", () => {
    const db = openDb({ path: file });
    sideWrite(file, "UPDATE meta SET value = '1.5' WHERE key = 'revision'");

    expect(db?.revision()).toBe(0);
    expect(loggedText()).toContain("rule revision was unusable (1.5)");
    expect(db?.saveRulesNow([card()], 0)).toBe("persisted");
    expect(db?.revision()).toBe(1);
  });

  it("连自愈都写不进去（库被锁成只读）→ 仍交 0，并点名 reset failed", () => {
    const db = openDb({ path: file });
    sideWrite(file, "UPDATE meta SET value = '-1' WHERE key = 'revision'");
    sideWrite(
      file,
      "CREATE TRIGGER reject_meta_update BEFORE UPDATE ON meta " +
        "WHEN NEW.key = 'revision' BEGIN SELECT RAISE(ABORT, 'meta is frozen'); END;",
    );

    expect(db?.revision()).toBe(0);
    expect(loggedText()).toContain("rule revision was unusable (-1)");
    expect(loggedText()).toContain("rule revision reset failed:");
    expect(loggedText()).toContain("meta is frozen");
  });
});

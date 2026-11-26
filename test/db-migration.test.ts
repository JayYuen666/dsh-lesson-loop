// db-migration 单元测试：一次性把旧介质搬进 SQLite 的那套判据。
//
// 每条用例都独立写死期望（库内计数、旧位是否被清、文件是否改名），不读实现里的常量。
// 迁移的失败面（旧端口读不懂 / 写库被拒 / 改名撞上已有备份）都只日志不抛——这里逐条钉住，
// 否则"装载期不被存量数据炸断"这条纪律就没有任何门在守。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIGRATION_IMPORT_BATCH, migrateToDb } from "../lib/db-migration.ts";
import { LESSON_DB_FILE, LessonDb } from "../lib/lesson-db.ts";
import type { LessonRecord, RulesRead, RuleCard, RulesRepository } from "../lib/lesson-store.ts";
import { logged, loggedText } from "./setup-logs.ts";

const t0 = 1_700_000_000_000;
const REJECT_DETAIL = "reject-row";
const MIGRATION_ABORTED_LOG = "lesson migration aborted:";

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

/** 旧端口替身：记录 save 调用（迁移已不回写，正常路径应恒为空）。 */
function fakeLegacy(over: { read?: () => RulesRead } = {}): RulesRepository & {
  saves: number;
} {
  const ledger = { saves: 0 };
  return {
    get saves() {
      return ledger.saves;
    },
    load: over.read ?? (() => ({ revision: 3, cards: [card()], usable: true })),
    save: () => {
      ledger.saves += 1;
      throw new Error("迁移不应回写旧位（字段已从 schema 摘除，写也写不进去）");
    },
  };
}

describe("migrateToDb：规则库那一半", () => {
  let dir: string;
  let file: string;
  let events: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lesson-mig-"));
    file = path.join(dir, LESSON_DB_FILE);
    events = path.join(dir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("没有旧规则源（legacy=null）时不动任何一块", () => {
    const db = LessonDb.open({ path: file });
    expect(db).not.toBeNull();
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    expect(db?.rulesCount()).toBe(0);
  });

  it("旧端口读不懂（usable:false）→ 不搬也不回写（等人工修）", () => {
    const db = LessonDb.open({ path: file });
    const legacy = fakeLegacy({ read: () => ({ revision: 1, cards: [], usable: false }) });
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(false);
    expect(legacy.saves).toBe(0);
    expect(logged()).toHaveLength(0);
  });

  it("旧位本来就是空数组 → 什么都不做", () => {
    const db = LessonDb.open({ path: file });
    const legacy = fakeLegacy({ read: () => ({ revision: 1, cards: [], usable: true }) });
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(false);
    expect(legacy.saves).toBe(0);
  });

  it("库空 + 旧位有卡：整片搬进库，旧位原样保留（不回写）", () => {
    const db = LessonDb.open({ path: file });
    const legacy = fakeLegacy({
      read: () => ({ revision: 7, cards: [card({ id: "a" }), card({ id: "b" })], usable: true }),
    });
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(true);
    expect(db?.rulesCount()).toBe(2);
    expect(legacy.saves).toBe(0);
  });

  it("库已有卡 + 旧位还有副本：不再写库，旧位也不回写（库是唯一写目标）", () => {
    const db = LessonDb.open({ path: file });
    void db!.rules.save([card({ id: "kept" })], 0);
    const legacy = fakeLegacy({
      read: () => ({ revision: 2, cards: [card({ id: "stale" })], usable: true }),
    });
    // 返 false 是**新语义**：这个返回值只回答"动过没有"。库里已有规则时迁移整块跳过，
    // 一张卡都没搬，所以不是 touched——旧实现拿 `rulesCount() > 0` 当成功，导致"库本来
    // 就非空"与"这一轮真搬成了"两种情形说同一句话。
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(false);
    expect(db?.rulesCount()).toBe(1);
    expect(db?.rules.load().cards[0]?.id).toBe("kept");
    expect(legacy.saves).toBe(0);
  });

  it("写库被拒（库侧表坏了）→ 不清空旧位：搬不成就不能删唯一存量", () => {
    const db = LessonDb.open({ path: file });
    const side = new DatabaseSync(file);
    side.exec("DROP TABLE rules");
    side.close();
    const legacy = fakeLegacy();
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(false);
    expect(legacy.saves).toBe(0);
    expect(loggedText()).toContain("rule migration failed:");
  });

  it("搬库被拒（卡体序列化不了）→ 旧位原样留着，回 false", () => {
    const db = LessonDb.open({ path: file });
    const legacy = fakeLegacy({
      read: () => ({
        revision: 2,
        cards: [card({ occurrences: 10n as unknown as number })],
        usable: true,
      }),
    });
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(false);
    expect(db?.rulesCount()).toBe(0);
    expect(legacy.saves).toBe(0);
    expect(loggedText()).toContain("rules write failed:");
  });

  it("反复 revision 冲突 → 重试三次后放弃，旧位原样留着", () => {
    const db = LessonDb.open({ path: file });
    const legacy = fakeLegacy({
      read: () => ({ revision: 3, cards: [card({ id: "a" })], usable: true }),
    });
    // 每次写都撞冲突：别的连接在"读 revision"与"写"之间总会推进版本，重试不收敛。
    let saves = 0;
    vi.spyOn(LessonDb.prototype, "saveRulesNow").mockImplementation(() => {
      saves += 1;
      return "conflict";
    });
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(false);
    expect(saves).toBe(3);
    expect(loggedText()).toContain("rule migration gave up after repeated revision conflicts");
    expect(db?.rulesCount()).toBe(0);
  });

  it("旧端口 load 抛错 → 只日志不抛穿，库保持空（下一次开机再试）", () => {
    const db = LessonDb.open({ path: file });
    const legacy = fakeLegacy({
      read: () => {
        throw new Error("read failed");
      },
    });
    expect(migrateToDb({ db: db!, legacy, eventsFile: events })).toBe(false);
    expect(db?.rulesCount()).toBe(0);
    expect(legacy.saves).toBe(0);
    expect(loggedText()).toContain("rule migration failed:");
  });
});

describe("migrateToDb：流水那一半", () => {
  let dir: string;
  let file: string;
  let events: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lesson-mig-"));
    file = path.join(dir, LESSON_DB_FILE);
    events = path.join(dir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("库已有新流水但旧文件无迁移标记 → 仍补导旧文件（新流水不短路重试）", () => {
    const db = LessonDb.open({ path: file });
    db?.lessons.append(lesson({ signature: "kept" }), 0);
    writeFileSync(events, `${JSON.stringify(lesson({ signature: "legacy" }))}\n`, "utf8");
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(true);
    expect(db?.lessons.count()).toBe(2);
    expect(db?.lessons.recent().map((row) => row.signature)).toStrictEqual(["kept", "legacy"]);
    expect(existsSync(events)).toBe(false);
    expect(existsSync(`${events}.bak`)).toBe(true);
  });

  it("失败后先写了新流水 → 移除故障重试仍能补导旧文件", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(
      events,
      `${[
        JSON.stringify(lesson({ signature: "old-a" })),
        JSON.stringify(lesson({ signature: "old-b", detail: REJECT_DETAIL })),
      ].join("\n")}\n`,
      "utf8",
    );
    const side = new DatabaseSync(file);
    side.exec(`
      CREATE TRIGGER reject_lesson BEFORE INSERT ON lessons
      WHEN NEW.payload LIKE '%${REJECT_DETAIL}%'
      BEGIN
        SELECT RAISE(ABORT, 'reject test row');
      END;
    `);
    side.close();
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    expect(db?.lessons.count()).toBe(0);
    expect(existsSync(events)).toBe(true);

    // 用户先写入一条新流水；旧守卫 hasLessons() 会因此短路，这里必须继续补导旧文件。
    db?.lessons.append(lesson({ signature: "new" }), 0);
    const side2 = new DatabaseSync(file);
    side2.exec("DROP TRIGGER reject_lesson");
    side2.close();
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(true);
    expect(db?.lessons.recent().map((row) => row.signature)).toStrictEqual([
      "new",
      "old-a",
      "old-b",
    ]);
    expect(existsSync(events)).toBe(false);
    expect(existsSync(`${events}.bak`)).toBe(true);
  });

  it("已有备份且源文件留在原地时写迁移标记：之后的新流水不会再次触发补导", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(events, `${JSON.stringify(lesson({ signature: "a" }))}\n`, "utf8");
    writeFileSync(`${events}.bak`, "上一轮备份\n", "utf8");
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(true);
    db?.lessons.append(lesson({ signature: "new" }), 0);
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    expect(db?.lessons.count()).toBe(2);
    expect(existsSync(events)).toBe(true);
  });

  it("库空但没有旧文件 → 什么都不做", () => {
    const db = LessonDb.open({ path: file });
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    expect(db?.lessons.count()).toBe(0);
  });

  it("逐行导入：空行/坏 JSON/归一失败都跳过，好的进库，成功后原文件改名 .bak", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(
      events,
      [
        "",
        "   ",
        "{",
        JSON.stringify({ category: 1, signature: "bad" }),
        JSON.stringify(lesson({ signature: "a" })),
        JSON.stringify(lesson({ signature: "b" })),
        "",
      ].join("\n"),
      "utf8",
    );
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(true);
    expect(db?.lessons.count()).toBe(2);
    expect(db?.lessons.recent().map((row) => row.signature)).toStrictEqual(["a", "b"]);
    expect(existsSync(events)).toBe(false);
    expect(existsSync(`${events}.bak`)).toBe(true);
    expect(loggedText()).toContain("lesson events imported");
  });

  it("一条都归一不出来 → 保留原文件、不改名 .bak（全坏不是迁移成功）", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(
      events,
      ["{", "null", JSON.stringify({ category: 1, signature: "bad" })].join("\n"),
      "utf8",
    );
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    expect(db?.lessons.count()).toBe(0);
    expect(existsSync(events)).toBe(true);
    expect(existsSync(`${events}.bak`)).toBe(false);
    expect(loggedText()).toContain("lesson events file has no importable record:");
  });

  it("已有同名 .bak → 原文件保留（不覆盖上一轮备份），仍算搬过", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(events, `${JSON.stringify(lesson({ signature: "a" }))}\n`, "utf8");
    writeFileSync(`${events}.bak`, "上一轮备份\n", "utf8");
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(true);
    expect(db?.lessons.count()).toBe(1);
    expect(readFileSync(events, "utf8")).toContain('"a"');
    expect(readFileSync(`${events}.bak`, "utf8")).toBe("上一轮备份\n");
    expect(loggedText()).toContain("backup already exists:");
  });

  it("单条写入失败 → 整批回滚，源文件不改名、不生成 .bak（剩余教训仍可在下次导入）", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(
      events,
      `${[
        JSON.stringify(lesson({ signature: "ok" })),
        JSON.stringify(lesson({ signature: "reject", detail: REJECT_DETAIL })),
      ].join("\n")}\n`,
      "utf8",
    );
    // 让第二条 INSERT 失败：旧实现会先写进第一条、再吞掉第二条错误，最后照样改名
    // `.bak`；下一次开机看到库里有流水就永远跳过剩下那条。事务化后整批回滚。
    const side = new DatabaseSync(file);
    side.exec(`
      CREATE TRIGGER reject_lesson BEFORE INSERT ON lessons
      WHEN NEW.payload LIKE '%${REJECT_DETAIL}%'
      BEGIN
        SELECT RAISE(ABORT, 'reject test row');
      END;
    `);
    side.close();
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    expect(db?.lessons.count()).toBe(0);
    expect(existsSync(events)).toBe(true);
    expect(existsSync(`${events}.bak`)).toBe(false);
    expect(loggedText()).toContain("lesson import failed:");
    expect(loggedText()).toContain(MIGRATION_ABORTED_LOG);
  });

  it("按 MIGRATION_IMPORT_BATCH 分批：第一批提交、第二批失败时源文件保留", () => {
    const db = LessonDb.open({ path: file });
    const total = MIGRATION_IMPORT_BATCH + 1;
    const lines = Array.from({ length: total }, (_unused, index) =>
      JSON.stringify(
        lesson({
          signature: `batch-${String(index)}`,
          detail: index === total - 1 ? REJECT_DETAIL : `ok-${String(index)}`,
        }),
      ),
    );
    writeFileSync(events, `${lines.join("\n")}\n`, "utf8");
    const side = new DatabaseSync(file);
    side.exec(`
      CREATE TRIGGER reject_lesson BEFORE INSERT ON lessons
      WHEN NEW.payload LIKE '%${REJECT_DETAIL}%'
      BEGIN
        SELECT RAISE(ABORT, 'reject test row');
      END;
    `);
    side.close();
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    expect(db?.lessons.count()).toBe(MIGRATION_IMPORT_BATCH);
    expect(existsSync(events)).toBe(true);
    expect(existsSync(`${events}.bak`)).toBe(false);
    expect(loggedText()).toContain(MIGRATION_ABORTED_LOG);
  });

  it("流水表缺失时导入失败只日志不抛（迁移入口承诺不阻断装载）", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(events, `${JSON.stringify(lesson({ signature: "a" }))}\n`, "utf8");
    const side = new DatabaseSync(file);
    side.exec("DROP TABLE lessons");
    side.close();
    expect(() => migrateToDb({ db: db!, legacy: null, eventsFile: events })).not.toThrow();
    expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    // 迁移标记在 meta 表里（不依赖 lessons 表）；现在先读一次 payload 集合做批间去重，
    // 表缺失时会在这一步被 catch，仍然是保留源文件、不阻断装载，只是不再进入逐批导入。
    expect(loggedText()).toContain("lesson migration failed:");
    expect(loggedText()).toContain("no such table: lessons");
    expect(existsSync(events)).toBe(true);
  });

  it("改名失败（目录不可写）→ 只日志；库里的行已经导入（下次开机按库计数跳过）", () => {
    const db = LessonDb.open({ path: file });
    writeFileSync(events, `${JSON.stringify(lesson({ signature: "a" }))}\n`, "utf8");
    // 目录去掉写位：existsSync(.bak) 仍是 false，renameSync 才失败（EACCES）。
    chmodSync(dir, 0o500);
    try {
      expect(migrateToDb({ db: db!, legacy: null, eventsFile: events })).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(db?.lessons.count()).toBe(1);
    expect(loggedText()).toContain("lesson migration failed:");
  });
});

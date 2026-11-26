// oxlint-disable eslint/max-classes-per-file -- 本文件的两个类是同一条语义链上的一对：
// LedgerConsumedElsewhereError 是 LessonDb.settleLedgerNow 抛出的、调用方必须单独辨认的那一种
// 失败（`host.ts` 的清算把它当"已由别处落地"而不是故障）。拆成独立文件只会让"这条错误从哪来"
// 多一跳，而 max-classes 那条规则的初衷（单文件职责过载）在这里不成立——它服务的就是这一个端口。
//
// lesson-db：规则库 / 教训流水 / 会话结算台账的**独立持久层**（`node:sqlite`）。
//
// 为什么从 profile 的 `cordis.patch.yml`（`config.rules`）搬出来：
//   1. 规则库是跨 profile 的用户数据，而 patch 文件是**每个 profile 一份**的部署文档——
//      切 profile 就等于换了一套规则，教训闭环跟着断档；
//   2. patch 文档由宿主整段重写（provider 的 CAS 是"整片覆盖"），证据无界增长时会连带
//      整份设置文档一起变大，且一次写坏就拖累同段的开关；
//   3. 教训流水（旧 `cache/lesson-loop/events.jsonl`）与结算台账本来就在别处，三块状态
//      分散在三种介质里，人工备份与排查都要记三个位置。
//
// 介质选 SQLite 而不是另一个 JSON/JSONL：`node:sqlite` 是 Node 内置模块（不加运行期依赖），
// WAL + `busy_timeout` 给了多进程同开的基本面（同一台机器上多个 profile 同时跑），
// 事务让"改规则 + 记计数"这类复合改动不会只落一半。下面那行 `import ... from "node:sqlite"`
// 是**静态导入**：缺这个内置模块的 Node 会在模块加载期就炸，而不是退化成"没有库"。这是刻意
// 留的——本包 `engines.node` 钉 `^24.22.3 || >=26.13.1`（照抄宿主自己的地板），两条线都内建
// `node:sqlite`，"缺模块"不在支持面内；反过来改成运行期取模块（`process.getBuiltinModule`）
// 会让 `host.js` 失去静态可分析的依赖形状（构建器的 externalize 判据与 `verify:published`
// 的解析面都按 `import ... from` 看），拿一条稳定契约换一个被 engines 排除的运行时，不划算。
// 真要放宽 Node 地板，先改 engines，再改这里。
//
// 表形状按**文档粒度**存（一行一张规则卡 / 一条教训），不是把字段拆成多表：
//   - LessonStore 的全部规则语义（归并、去重、CAS 重放）都在内存里对整张卡做，端口只
//     需要"读全部 / 写全部"；
//   - 拆表会把"证据数组"变成跨表外键，而合并/迁移时会换 id（源卡并进主卡），外键跟着
//     搬家的成本远大于收益；
//   - project / status / updated_at 单独成列只为建索引与投影，是**冗余副本**，写路径由
//     save 一处保证同步（没有外部写入口）。
// 代价明说：单卡更新要重写整行 JSON，证据无界增长时写放大随卡体量线性上升。规则卡是
// 人工判断后的少量对象（本机真实库 4 张），这个量级下可接受；证据若要单独分页落库，
// 那是下一次演进（卡片读取已经按 cursor 分页，接口不需要再变）。
//
// 一致性：`meta.revision` 是规则库的单调版本号，替代旧 settings revision 承担 CAS。
// 每个进程一条连接（`DatabaseSync` 不是并发安全的），写事务一律 `BEGIN IMMEDIATE`，
// 撞锁时由 `busy_timeout` 等待而不是立刻 SQLITE_BUSY。

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { normalizeLessonRow, normalizeRuleCardRow } from "./lesson-store.ts";
import type {
  LessonRecord,
  LessonsLog,
  RuleCard,
  RulesRead,
  RulesRepository,
  RulesWriteOutcome,
} from "./lesson-store.ts";

/** 打开失败 / 读失败 / 写失败的日志前缀：与 host 侧其他 `[lesson-loop]` 行同前缀，
 *  便于按前缀抓一整段（测试的模板表也按这个前缀登记）。 */
const LOG_PREFIX = "[lesson-loop]";

/** WAL 下多进程写锁的等待窗口（毫秒）。取 5s：同机多个 profile 同时收尾清算时，
 *  写事务都是毫秒级，5s 足够跨过一次争用；等不到就按失败回执处理，不无限挂住事件循环。 */
const BUSY_TIMEOUT_MS = 5000;

/** 当前库结构版本。v2 给 `session_ledger` 加了 `exposure_at` 列，并把两个 ID 数组的语义
 *  从"本会话累计违过/过哪些"改成"还没计进规则库的队列"（见 {@link LessonDb.noteLedger}）。
 *  旧库由 {@link LessonDb.migrateSchema} 就地升上来。 */
const SCHEMA_VERSION = 2;

/** 台账两个 ID 队列的空值（JSON 文本）。 */
const EMPTY_IDS = "[]";

/** 写事务的开场（重复 5 次的那句）。取 IMMEDIATE 而不是默认的 DEFERRED：后者要到第一次写
 *  才拿写锁，两个进程同时开事务会双双通过 `revision` 比对再一起撞 SQLITE_BUSY。 */
const BEGIN_SQL = "BEGIN IMMEDIATE";

/** 预编译语句的类型别名：裁剪批处理只依赖 `all` / `run` 两个方法。 */
type SqlStatement = ReturnType<DatabaseSync["prepare"]>;

/** 一条教训落库的 payload 文本：插入、去重集合与测试诊断都按同一份序列化口径。 */
function payloadOf(record: LessonRecord): string {
  return JSON.stringify(record);
}

/** 建表语句。`IF NOT EXISTS` 让每次开机都能幂等执行；版本号另存 `meta.schema_version`。
 *  列定义**永远写最新形状**：新库一次建到位，旧库靠 {@link LessonDb.migrateSchema} 的
 *  `ALTER TABLE` 追平（`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列）。
 *
 *  两条索引（`rules(project, status)`、`lessons(project, ts)`）**当前没有读路径命中**：
 *  `loadRules` / `readLessonRecords` / `trimLessons` 全是 `ORDER BY id`，project 过滤在
 *  JS 里做（`readLessons` 走 `cachedLessons().filter(...)`）。保留它们是因为
 *  `rules.project/status` 与 `lessons.project/ts` 是给"下一次把过滤下推到 SQL"预留的
 *  冗余副本（写路径由 `saveRulesNow` / `insertLesson` 一处同步，成本是每卡每教训一次），
 *  收掉它们就必须同时改这两列的写入形状。别照着它们写查询——现阶段它们只是成本。
 *
 *  `lesson_stats` 是**只读派生的单行计数器**：`appendLesson` 的容量保险丝若每次都跑
 *  `SUM(LENGTH(...))`，`maxLessonsBytes > 0` 时每条追加都要全表扫描。这里让插入/删除触发
 *  器在同一条 SQL 语句里维护字节数与行数，裁剪只读这一行、按主键取最旧一批。触发器是库内
 *  唯一的维护点，跨连接/跨进程的写也不会绕开它；首次打开或计数器缺失时按 `lessons` 实量
 *  重建一次，之后正常开机只读这一行，不把全表扫描搬到每次启动。 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_project_status ON rules(project, status);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  project TEXT NOT NULL,
  session_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lessons_project_ts ON lessons(project, ts);
CREATE TABLE IF NOT EXISTS lesson_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_bytes INTEGER NOT NULL,
  row_count INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS lesson_stats_insert AFTER INSERT ON lessons
BEGIN
  UPDATE lesson_stats
    SET total_bytes = total_bytes + LENGTH(CAST(NEW.payload AS BLOB)),
        row_count = row_count + 1
    WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS lesson_stats_delete AFTER DELETE ON lessons
BEGIN
  UPDATE lesson_stats
    SET total_bytes = total_bytes - LENGTH(CAST(OLD.payload AS BLOB)),
        row_count = row_count - 1
    WHERE id = 1;
END;
CREATE TABLE IF NOT EXISTS session_ledger (
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  violated TEXT NOT NULL,
  passed TEXT NOT NULL,
  settled_at INTEGER,
  exposure_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, project)
);
`;

/** 台账的一行。
 *
 *  `violated` / `passed` 是**还没被计进规则库的** id 队列，不是"本会话一共违过哪些"：
 *  每一笔在这里排队，清算成功时在规则计数那个事务里被取走（见
 *  {@link LessonDb.consumeLedgerNow}）。这样"计了没计"只有库这一处真相，跨进程补算
 *  不会把已经计过的一笔再计一次。
 *
 *  `settledAt` = 队列最后一次被清空的时刻（排查用）；`exposureAt` = 这个 (会话,项目) 的
 *  暴露度被计过的时刻（NULL = 还没计）。两者必须分开：补算走零暴露度（会话已经不在本
 *  进程），不能让它的落定把"暴露度还没计"这件事一并抹掉。 */
export interface LedgerRow {
  readonly sessionId: string;
  readonly project: string;
  readonly violated: readonly string[];
  readonly passed: readonly string[];
  readonly settledAt: number | null;
  readonly exposureAt: number | null;
}

/** 构造参数：路径必填，`now` 可注入（测试要钉时间戳，不靠真钟）。 */
export interface LessonDbOptions {
  readonly path: string;
  readonly now?: () => number;
}

/** 不可用读回执：与 rules-namespace 同一哨兵（-1 过不了 revision 形状判定，
 *  误用当场显形；0 是合法版本号，不能拿来当"不可用"）。 */
const UNUSABLE_READ: RulesRead = Object.freeze({
  revision: -1,
  cards: Object.freeze([]),
  usable: false,
});

/** 非负整数判据（revision 的唯一形状）。 */
function isUsableRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** JSON 列 → 字符串数组（坏值折成空数组：台账是"可选补算"的输入，坏一行不该让
 *  整场会话清不了算）。 */
function stringArrayOf(text: unknown): string[] {
  if (typeof text !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 可空整数列 → number | null（坏值折 null：时间戳列要么是有效秒数，要么就是没打过）。 */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 台账的这一笔已经被别处取走（另一个进程的清算/补算，或另一条 profile）。
 *
 * 它不是故障，而是**必须回滚**的信号：继续写就等于把同一笔再计一次。抛错让
 * `saveRules` 整笔回滚（规则计数不落），调用方据此判定"这一场已经清过"。
 */
export class LedgerConsumedElsewhereError extends Error {
  public constructor(sessionId: string, project: string) {
    super(`ledger row already consumed: ${sessionId} / ${project}`);
    this.name = "LedgerConsumedElsewhereError";
  }
}

/**
 * 规则库 / 流水 / 台账的 SQLite 端口。
 *
 * 构造只经 {@link open}：打开失败（目录不可写、库文件被别的进程锁死到无法建表）返回 null，
 * 由 host 回退到旧设置端口并在日志里点名——**不抛**，装载期一次磁盘故障不该让整条总线
 * 不加载。
 */
export class LessonDb {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  /** 本连接自己写过的次数：`PRAGMA data_version` 只反映**别的连接**的写，自己写不推进它。 */
  private localWrites = 0;
  /** 教训读缓存（见 {@link LessonDb.cachedLessons}）。 */
  private lessonCache: { key: string; rows: LessonRecord[] } | null = null;
  /** 连接是否已关闭：关闭后的写一律按 rejected 回执，而不是抛到宿主事件循环上。 */
  private closed = false;
  /** 台账有没有 `exposure_at` 列（开库并跑完升级后探一次，此后不再问库）。
   *  只有"v1 库升级失败"这一态会是 false：那时库按旧形状继续可用，台账的读写要退到
   *  不追暴露度的形态，而不是整条台账报 `no such column`（那会让清算与补算全瘫）。
   *  默认 true：`SCHEMA_SQL` 建出来的新库一定带这一列，探测只是覆盖"旧库升不上来"那一态。 */
  private exposureColumnKnown = true;

  /** 交给 LessonStore 的规则库端口（方法绑在实例上，store 只看到 load/save 两位）。 */
  public readonly rules: RulesRepository;

  /** 交给 LessonStore 的教训流水端口（append/recent/count 三位，与文件介质同形）。 */
  public readonly lessons: LessonsLog;

  private constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
    this.rules = {
      load: (): RulesRead => this.loadRules(),
      // 端口契约是 Promise；实现全程同步，故这里只是把同一个同步核的结果交给异步外壳。
      save: (cards, revision, onPersisted): Promise<RulesWriteOutcome> =>
        Promise.resolve(this.saveRulesNow(cards, revision, onPersisted)),
    };
    this.lessons = {
      append: (record, maxBytes): void => {
        this.appendLesson(record, maxBytes);
      },
      recent: (project, limit = 0): LessonRecord[] => this.readLessons(project, limit),
      count: (): number => this.lessonsCount(),
    };
  }

  /**
   * 打开（或创建）库并建表。
   * @param options 路径与可选时钟
   * @returns 端口；打不开时 null（调用方回退）
   */
  public static open(options: LessonDbOptions): LessonDb | null {
    const now = options.now ?? Date.now;
    try {
      mkdirSync(path.dirname(options.path), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS });
      // 目录已 0700，但文件本身默认仍可能是 0644；POSIX 上收紧到 0600。Windows 没有
      // POSIX 权限位，且宿主自己的 profile 目录已经是边界，故这一支只作加固。
      /* v8 ignore next 4 —— Windows 文件系统没有 POSIX 权限位，chmod 失败也不影响打开 */
      try {
        chmodSync(options.path, 0o600);
      } catch (error) {
        console.error(`${LOG_PREFIX} database permission hardening failed: ${errorText(error)}`);
      }
      // WAL：读不阻塞写、写不阻塞读，多进程同开的默认口径；synchronous=NORMAL 是 WAL 的
      // 常规档（崩溃丢最后一笔未 checkpoint 的事务，不损坏库）。
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec(SCHEMA_SQL);
      const instance = new LessonDb(db, now);
      instance.ensureMeta();
      // 计数器缺失（新库/旧库首次带统计表）时重建一次；已有行只读一行，不每次开机全表 SUM。
      instance.lessonStats();
      instance.migrateSchema();
      // 升级跑完才探：v1 升上来时列是这一步才有的，早探会记住 null 并永久降级。
      instance.exposureColumnKnown = instance.hasColumn("session_ledger", "exposure_at");
      return instance;
    } catch (error) {
      console.error(`${LOG_PREFIX} rule database unavailable: ${errorText(error)}`);
      return null;
    }
  }

  /**
   * 关闭连接（插件卸载/热重载时由宿主 disposer 调）。
   *
   * 为什么必须有：`DatabaseSync` 活到进程 GC 为止。插件热卸载后旧实例仍持着 WAL 的读快照
   * 与写锁，新实例再开同一个库只能硬等 `busy_timeout`；退出/搬迁路径上 `-wal` / `-shm`
   * 也还映射着，库文件删不掉。关闭幂等，重复调用无副作用。
   */
  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.db.close();
    } catch (error) {
      // 关闭失败不该抛到宿主卸载路径上：连接已经不再使用，日志足够定位。
      console.error(`${LOG_PREFIX} rule database close failed: ${errorText(error)}`);
    }
  }

  /** 首次开机补齐 meta 的固定键（幂等）；schema_version 由 {@link LessonDb.migrateSchema} 追平。 */
  private ensureMeta(): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)");
    insert.run("schema_version", String(SCHEMA_VERSION));
    insert.run("revision", "0");
  }

  /**
   * 把旧库的结构与台账语义就地升到 {@link SCHEMA_VERSION}。
   *
   * v1 → v2 的两件事：
   *   1. 补 `exposure_at` 列（旧库建表语句不会加列，只能 ALTER）；
   *   2. 改台账行语义。v1 的两个数组是"本会话累计违过/过哪些"，落定时只打 `settled_at`
   *      而不清数组，于是同一行下一次被读到又会整笔再计一遍——这正是重复计数的根因。
   *      v2 把数组定义成"待计队列"，所以**已落定的行必须清空**，否则升级后第一次补算
   *      会把历史上每一笔重算一次。
   */
  private migrateSchema(): void {
    const version = this.metaNumber("schema_version", 0);
    if (version >= SCHEMA_VERSION) {
      return;
    }
    try {
      this.db.exec(BEGIN_SQL);
      if (!this.hasColumn("session_ledger", "exposure_at")) {
        this.db.exec("ALTER TABLE session_ledger ADD COLUMN exposure_at INTEGER");
      }
      // 已落定的行按新语义清空队列；未落定的原样保留（它们的数组就是待计队列）。
      this.db
        .prepare("UPDATE session_ledger SET violated = ?, passed = ? WHERE settled_at IS NOT NULL")
        .run(EMPTY_IDS, EMPTY_IDS);
      this.setMeta("schema_version", String(SCHEMA_VERSION));
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollbackQuietly();
      // 升级失败不该让插件装不上：库仍按旧形状可用，只是台账少一层去重。
      console.error(`${LOG_PREFIX} rule database migration failed: ${errorText(error)}`);
    }
  }

  /** 列存在性判据（`ALTER TABLE ADD COLUMN` 没有幂等形态，只能先问 table_info）。 */
  private hasColumn(table: string, column: string): boolean {
    for (const row of this.db.prepare(`PRAGMA table_info(${table})`).all()) {
      if (fieldOf(row, "name") === column) {
        return true;
      }
    }
    return false;
  }

  /**
   * 台账查询里 `exposure_at` 那一位该写什么：有列就取列，没有（v1 库升级失败）就写常量
   * `NULL`——两条读语句因此共用同一份 FROM 子句，不会在降级态上抛 `no such column`。
   * 结果在开库时探好并缓存（{@link exposureColumnKnown}）：表结构在一条连接的生命周期里
   *  不会变，而关闭后再问 `PRAGMA` 会抛——读面在关闭态必须降级成空数组，不是抛错。
   */
  private exposureColumn(): string {
    return this.exposureColumnFlag() ? "exposure_at" : "NULL AS exposure_at";
  }

  /** 台账有没有 `exposure_at` 列（开库时探过一次，这里只读缓存）。 */
  private exposureColumnFlag(): boolean {
    return this.exposureColumnKnown;
  }

  /** 记一笔计数用的 UPSERT：有 `exposure_at` 列就一并写 NULL，没有就少一列。 */
  private noteLedgerSql(): string {
    const columns = this.exposureColumnFlag()
      ? "session_ledger(session_id, project, violated, passed, settled_at, exposure_at, updated_at) VALUES(?, ?, ?, ?, NULL, NULL, ?)"
      : "session_ledger(session_id, project, violated, passed, settled_at, updated_at) VALUES(?, ?, ?, ?, NULL, ?)";
    return (
      `INSERT INTO ${columns} ON CONFLICT(session_id, project) DO UPDATE SET ` +
      "violated = excluded.violated, passed = excluded.passed, updated_at = excluded.updated_at"
    );
  }

  /** 结清台账用的 UPSERT：形状随 `exposure_at` 列在不在而变（见 {@link LessonDb.exposureColumnFlag}）。 */
  private settleLedgerSql(): string {
    if (!this.exposureColumnFlag()) {
      return (
        "INSERT INTO session_ledger(session_id, project, violated, passed, settled_at, updated_at) " +
        "VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, project) DO UPDATE SET " +
        "violated = excluded.violated, passed = excluded.passed, settled_at = excluded.settled_at, " +
        "updated_at = excluded.updated_at"
      );
    }
    return (
      "INSERT INTO session_ledger(session_id, project, violated, passed, settled_at, exposure_at, updated_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, project) DO UPDATE SET " +
      "violated = excluded.violated, passed = excluded.passed, settled_at = excluded.settled_at, " +
      "exposure_at = excluded.exposure_at, updated_at = excluded.updated_at"
    );
  }

  /** meta 里的数字位：缺失/坏值一律回 fallback（revision 坏成 0 只会多一次冲突重放，
   *  不会写出错误数据）。 */
  private metaNumber(key: string, fallback: number): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    const raw = fieldOf(row, "value");
    if (typeof raw !== "string") {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /** 写 meta（调用方保证在事务内或允许单独提交）。 */
  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * 规则库当前版本号（迁移与卡片并发判定都要读它）。
   *
   * 坏值**就地自愈**：`meta.revision` 是会被外部编辑（或旧版本写坏）的一格。先前只有
   * "写成功后推进 revision"，于是坏值让每一笔 `saveRules` 都回 rejected，而 rejected 又
   * 不推进 revision——规则库永久变只读且一声不响。归零的代价只是多一次 CAS 冲突重放，
   * 比"写不进去"轻得多。
   */
  public revision(): number {
    const raw = this.metaNumber("revision", 0);
    if (isUsableRevision(raw)) {
      return raw;
    }
    console.error(`${LOG_PREFIX} rule revision was unusable (${String(raw)}) — reset to 0`);
    try {
      this.setMeta("revision", "0");
    } catch (error) {
      // 连自愈都写不进去（库只读/被锁死）：仍交出 0，让写入按 conflict 重放而不是永久拒绝。
      console.error(`${LOG_PREFIX} rule revision reset failed: ${errorText(error)}`);
    }
    return 0;
  }

  /** 只在测试/迁移用：当前库里的规则卡条数。 */
  public rulesCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM rules").get();
    const total = fieldOf(row, "n");
    // COUNT(*) 恒为整数：非 number 不可构造，只作防御。
    /* v8 ignore next —— COUNT(*) 恒为整数 */
    return typeof total === "number" ? total : 0;
  }

  /** 有效教训数：与 {@link LessonDb.readLessons} 共用同一套归一规则。
   *
   *  不能再让 `COUNT(*)` 直接回答这个数：库里的原始行可能非文本、坏 JSON 或归一失败，
   *  读侧会跳过它们，计数却把全部行算进去——界面上的"教训 N 条"于是大于列表实际长度。
   *  计数读同一批 payload 并走同一条 normalizeLessonRow，两边定义只有一个。
   *  这条是卡片轮询的热路径，故读面走 {@link LessonDb.cachedLessons}（按库水位失效）。
   *  读失败折 0 是有意的：界面上少一个数字好过整张卡片报错；要判"库里到底有没有"
   *  必须用 {@link LessonDb.hasLessons}（它不折）。 */
  public lessonsCount(): number {
    try {
      return this.cachedLessons().length;
    } catch (error) {
      console.error(`${LOG_PREFIX} lesson count failed: ${errorText(error)}`);
      return 0;
    }
  }

  /**
   * 库里是否已有教训行（诊断与测试用；迁移的重试守卫已改为 {@link LessonDb.lessonsMigrated}）。
   *
   * 与 {@link LessonDb.lessonsCount} 的关键差别：**读失败抛出**，不折成"空库"。
   */
  public hasLessons(): boolean {
    return this.db.prepare("SELECT 1 AS one FROM lessons LIMIT 1").get() !== undefined;
  }

  /** 旧 events.jsonl 是否已完成迁移（meta 标记，与“库里有没有任意教训”区分开）。
   *  迁移失败后用户可能先写了新教训；只看 `hasLessons()` 会把重试短路，所以守卫必须是
   *  这条只由“整份旧文件成功导入（或已有备份而不再改名）”写下的标记。 */
  public lessonsMigrated(): boolean {
    return (
      this.db.prepare("SELECT 1 AS one FROM meta WHERE key = ?").get("lessons_migrated") !==
      undefined
    );
  }

  /** 记下旧 events.jsonl 已完成迁移；由迁移成功路径调用（失败路径绝不写）。 */
  public markLessonsMigrated(): void {
    this.setMeta("lessons_migrated", "1");
  }

  /**
   * 读全部规则卡。任何一行 JSON 反序列化/归一失败都退 `usable:false`：
   * 库是我们自己写的，坏行只可能来自外部编辑或磁盘损坏；此时把"读不懂"折成"空库"
   * 再让下一次 save 整片覆盖，等于替坏数据背书（与 settings 端口同一条纪律）。
   */
  private loadRules(): RulesRead {
    try {
      const rows = this.db.prepare("SELECT payload FROM rules ORDER BY id").all();
      const cards: RuleCard[] = [];
      for (const row of rows) {
        const payload = fieldOf(row, "payload");
        if (typeof payload !== "string") {
          console.error(`${LOG_PREFIX} rule library unreadable: non-text payload`);
          return UNUSABLE_READ;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          console.error(`${LOG_PREFIX} rule library unreadable: malformed payload`);
          return UNUSABLE_READ;
        }
        const card = normalizeRuleCardRow(parsed);
        if (card === null) {
          console.error(`${LOG_PREFIX} rule library unreadable: row is not a rule card`);
          return UNUSABLE_READ;
        }
        cards.push(card);
      }
      return { revision: this.revision(), cards, usable: true };
    } catch (error) {
      console.error(`${LOG_PREFIX} rule read failed: ${errorText(error)}`);
      return UNUSABLE_READ;
    }
  }

  /**
   * 带 revision 的整片写：revision 不符即 `conflict`（不写任何一行），供 LessonStore
   * 重读重放；写事务里逐卡 upsert、删掉本次读之后消失的卡（合并迁移会丢源卡），
   * 最后把 revision +1。整段在一个 `BEGIN IMMEDIATE` 里，中途失败整体回滚。
   *
   * 核是**同步**的：`rules.save` 的 Promise 只是端口外壳，而迁移路径需要"返回时已经
   * 落库"这个确定性（它读回执决定是否改名源文件）。同一份核两处共用，不写第二遍。
   */
  public saveRulesNow(
    cards: readonly RuleCard[],
    revision: number,
    onPersisted?: () => void,
  ): RulesWriteOutcome {
    if (this.closed) {
      console.error(`${LOG_PREFIX} rules write refused: database is closed`);
      return "rejected";
    }
    if (!isUsableRevision(revision)) {
      console.error(`${LOG_PREFIX} rules write refused: no usable revision (${String(revision)})`);
      return "rejected";
    }
    try {
      this.db.exec(BEGIN_SQL);
      const current = this.revision();
      if (current !== revision) {
        this.db.exec("COMMIT");
        return "conflict";
      }
      const existing = new Set<string>();
      for (const row of this.db.prepare("SELECT id FROM rules").all()) {
        const id = fieldOf(row, "id");
        /* v8 ignore next —— id 是 TEXT PRIMARY KEY（建表即非空），读回恒为字符串 */
        if (typeof id === "string") {
          existing.add(id);
        }
      }
      const keep = new Set<string>();
      for (const card of cards) {
        keep.add(card.id);
        const payload = JSON.stringify(card);
        this.db
          .prepare(
            "INSERT INTO rules(id, project, status, updated_at, payload) VALUES(?, ?, ?, ?, ?) " +
              "ON CONFLICT(id) DO UPDATE SET project = excluded.project, status = excluded.status, " +
              "updated_at = excluded.updated_at, payload = excluded.payload",
          )
          .run(card.id, card.project, card.status, this.now(), payload);
      }
      for (const id of existing) {
        if (!keep.has(id)) {
          this.db.prepare("DELETE FROM rules WHERE id = ?").run(id);
        }
      }
      this.setMeta("revision", String(current + 1));
      // 会话清算的落定标记与规则计数必须在同一个事务里：先前分开写时，进程在
      // `saveRules` 成功与落定之间崩溃，下一次开机就会把同一场会话的 suppressed 再记一遍。
      // 回调抛错 → 下面 catch 整体回滚，规则计数也不落。
      onPersisted?.();
      this.db.exec("COMMIT");
      this.localWrites += 1;
      return "persisted";
    } catch (error) {
      this.rollbackQuietly();
      console.error(`${LOG_PREFIX} rules write failed: ${errorText(error)}`);
      return "rejected";
    }
  }

  /** 回滚失败只吞掉（原始错误已经在调用方日志里，回滚错误再抛会盖掉它）。 */
  private rollbackQuietly(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // 事务可能根本没开（BEGIN 前就失败），回滚一次失败是正常情形。
    }
  }

  /**
   * 追加一条教训。`maxBytes > 0` 时按 payload 的 **UTF-8 字节总长**做磁盘保险丝
   * （与旧 JSONL `maxLessonsBytes` 同语义：超了从最旧删起，0 = 不设上限、内容零截断）。
   * 失败只日志——流水是派生数据，热路径不许抛穿。
   */
  public appendLesson(record: LessonRecord, maxBytes: number): void {
    try {
      this.insertLesson(record);
      // 插入已经提交（触发器也维护好计数）；先推进缓存水位再裁剪。裁剪若因磁盘/触发器
      // 失败而抛，下一次读缓存仍必须看到刚落下的这一条，不能继续用插入前的旧缓存。
      this.localWrites += 1;
      if (maxBytes > 0) {
        this.trimLessons(maxBytes);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} lesson append failed: ${errorText(error)}`);
    }
  }

  /**
   * 迁移专用：一批教训要么全部进库，要么整批回滚。
   *
   * `appendLesson` 的失败只日志、返回 void；迁移若沿用它，某一行写失败时后续行仍会
   * 继续，最后按"处理过文件"改名 `.bak`，剩下的教训就永久跳过。这里用一条
   * `BEGIN IMMEDIATE` 包住整批，返回**实际提交的条数**；任一行失败即回滚并返回 0，
   * 让调用方保留源文件。
   *
   * 两条与旧实现不同的地方，都是"半坏数据"那类缺陷的根因修法：
   *   - `skip` 让调用方**分批**调用：整份旧文件塞进一条事务时，同机其它 profile 的写会
   *     全部撞 `busy_timeout` 失败，历史文件越大撞得越狠；
   *   - 插入前按 payload 去重（`WHERE NOT EXISTS`）：`lessons` 表没有唯一约束，重跑一次
   *     迁移（或 `.bak` 没建成功）会让每条教训在库里再来一份。
   * @param records 这份源文件里的全部教训（已归一）
   * @param skip 前几批已经落库的条数（本批从这一位之后开始）
   * @param limit 本批最多导入多少条；迁移按 MIGRATION_IMPORT_BATCH 分批，缺省导入剩余全部
   * @param seen 可选的已存在 payload 集合。迁移在开始时一次读出库内 payload，后续批次共用
   *   这一份集合，避免每条都执行一次 `WHERE NOT EXISTS` 全表扫描；集合只在整批提交成功后
   *   才写回，回滚不会留下“已去重但没入库”的假记录。缺省仍走 SQL 去重，保持旧 API 语义。
   */
  public importLessons(
    records: readonly LessonRecord[],
    skip = 0,
    limit?: number,
    seen?: Set<string>,
  ): number {
    const fresh =
      limit === undefined ? records.slice(skip) : records.slice(skip, skip + Math.max(0, limit));
    if (fresh.length === 0) {
      return 0;
    }
    try {
      this.db.exec(BEGIN_SQL);
      const batchSeen = seen === undefined ? undefined : new Set<string>();
      for (const record of fresh) {
        if (seen === undefined || batchSeen === undefined) {
          this.insertLessonOnce(record);
        } else {
          const payload = payloadOf(record);
          if (!seen.has(payload) && !batchSeen.has(payload)) {
            this.insertLesson(record, payload);
            batchSeen.add(payload);
          }
        }
      }
      this.db.exec("COMMIT");
      if (batchSeen !== undefined) {
        for (const payload of batchSeen) {
          seen?.add(payload);
        }
      }
      this.localWrites += 1;
      return fresh.length;
    } catch (error) {
      this.rollbackQuietly();
      console.error(`${LOG_PREFIX} lesson import failed: ${errorText(error)}`);
      return 0;
    }
  }

  /** 单条插入的共用落笔（调用方决定是否包事务）。 */
  private insertLesson(record: LessonRecord, payload = payloadOf(record)): void {
    this.db
      .prepare("INSERT INTO lessons(ts, project, session_id, payload) VALUES(?, ?, ?, ?)")
      .run(record.ts, record.project, record.sessionId ?? null, payload);
  }

  /** 迁移用的幂等插入：同一条 payload 已经在库里就跳过（重跑迁移不会翻倍）。 */
  private insertLessonOnce(record: LessonRecord): void {
    const payload = payloadOf(record);
    this.db
      .prepare(
        "INSERT INTO lessons(ts, project, session_id, payload) SELECT ?, ?, ?, ? " +
          "WHERE NOT EXISTS (SELECT 1 FROM lessons WHERE payload = ?)",
      )
      .run(record.ts, record.project, record.sessionId ?? null, payload, payload);
  }

  /** 按 payload 的 UTF-8 字节总长裁最旧，直到回到上限以内；**永远保留最新一条**。
   *
   *  `LENGTH(TEXT)` 在 SQLite 里数的是字符，不是字节：中文 payload 的实际磁盘占用可达到
   *  字段值的 3 倍，旧的字符口径会让 `maxLessonsBytes` 名不副实。`CAST(payload AS BLOB)`
   *  后 `LENGTH` 才是字节数，与旧 JSONL 的 `Buffer.byteLength` 同口径。
   *
   *  保留最新一条是有意的：保险丝保护磁盘，但不该把"最近发生的一条教训"本身删掉；
   *  单条超过上限时宁可暂时越过上限，也不把流水清空。
   *
   *  计数从 `lesson_stats` 单行读取（插入/删除触发器维护），不再每次 `SUM` 全表；
   *  删除按主键取最旧的一小批。整段删除放在一个写事务里，回滚不会留下半裁的流水。 */
  private trimLessons(maxBytes: number): void {
    const stats = this.lessonStats();
    if (stats.totalBytes <= maxBytes || stats.rowCount <= 1) {
      return;
    }
    const state = { totalBytes: stats.totalBytes, rowCount: stats.rowCount };
    const oldest = this.db.prepare(
      "SELECT id, LENGTH(CAST(payload AS BLOB)) AS len FROM lessons ORDER BY id LIMIT 256",
    );
    const remove = this.db.prepare("DELETE FROM lessons WHERE id = ?");
    this.db.exec(BEGIN_SQL);
    try {
      while (state.totalBytes > maxBytes && state.rowCount > 1) {
        /* v8 ignore next —— 计数器由触发器维护；只有外部手工改坏计数且表已空才会走到 */
        if (!LessonDb.deleteOldestBatch(oldest, remove, maxBytes, state)) {
          break;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollbackQuietly();
      throw error;
    }
  }

  /** 删除最旧的一小批；返回是否真的删了行。单条删除失败由调用方的整段事务回滚。 */
  private static deleteOldestBatch(
    oldest: SqlStatement,
    remove: SqlStatement,
    maxBytes: number,
    state: { totalBytes: number; rowCount: number },
  ): boolean {
    const rows = oldest.all();
    let deleted = false;
    for (const row of rows) {
      if (state.totalBytes <= maxBytes || state.rowCount <= 1) {
        break;
      }
      const id = fieldOf(row, "id");
      const len = fieldOf(row, "len");
      // id 是 INTEGER PRIMARY KEY（rowid 别名），SQLite 保证它是整数；len 由 NOT NULL
      // payload 算出，同样是整数。这两支只作磁盘层的防御。
      /* v8 ignore next —— id/len 的 SQLite 类型不可构造为非整数 */
      if (typeof id === "number" && typeof len === "number") {
        remove.run(id);
        state.totalBytes -= len;
        state.rowCount -= 1;
        deleted = true;
      }
    }
    return deleted;
  }

  /**
   * 流水计数（`lesson_stats` 单行）。正常路径只读一行；表被外部删除或计数器缺失时，
   * 按 `lessons` 实量重建一次，后续再由触发器维护。重建是全表操作，但只发生在异常态。
   */
  private lessonStats(): { totalBytes: number; rowCount: number } {
    const row = this.db
      .prepare("SELECT total_bytes, row_count FROM lesson_stats WHERE id = 1")
      .get();
    const totalBytes = fieldOf(row, "total_bytes");
    const rowCount = fieldOf(row, "row_count");
    if (typeof totalBytes === "number" && typeof rowCount === "number") {
      return { totalBytes, rowCount };
    }
    const rebuilt = this.db
      .prepare(
        "SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS total_bytes, COUNT(*) AS row_count " +
          "FROM lessons",
      )
      .get();
    const bytes = fieldOf(rebuilt, "total_bytes");
    const rows = fieldOf(rebuilt, "row_count");
    /* v8 ignore next 2 —— SUM/COUNT 在 SQLite 里恒为整数，非 number 不可构造 */
    if (typeof bytes !== "number" || typeof rows !== "number") {
      return { totalBytes: 0, rowCount: 0 };
    }
    this.db
      .prepare(
        "INSERT INTO lesson_stats(id, total_bytes, row_count) VALUES(1, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET total_bytes = excluded.total_bytes, " +
          "row_count = excluded.row_count",
      )
      .run(bytes, rows);
    return { totalBytes: bytes, rowCount: rows };
  }

  /**
   * 迁移开始时一次性读出库里已有的 payload 文本，用来在内存里做批间去重；避免
   * `importLessons` 的每条记录都跑一次 `WHERE NOT EXISTS` 全表扫描。
   */
  public lessonPayloads(): Set<string> {
    const out = new Set<string>();
    for (const row of this.db.prepare("SELECT payload FROM lessons").all()) {
      const payload = fieldOf(row, "payload");
      if (typeof payload === "string") {
        out.add(payload);
      }
    }
    return out;
  }

  /**
   * 读教训：按写入序（id）返回，`limit > 0` 取最近 N 条（与旧 `recentLessons` 的
   * "尾部 N 条"一致）。坏行按 normalizeLessonRow 判空跳过——与旧读侧同一条归一规则。
   * 计数与迁移判定都复用同一个读面，不再各自定义"有效行"。
   */
  public readLessons(project?: string, limit = 0): LessonRecord[] {
    const out =
      project === undefined
        ? this.cachedLessons()
        : this.cachedLessons().filter((record) => record.project === project);
    return limit > 0 ? out.slice(-limit) : out;
  }

  /**
   * 全量有效教训（坏行跳过），带缓存。
   *
   * `stats` 是卡片轮询路径，而"教训 N 条"原先每次都全表 `SELECT payload` + `JSON.parse`
   * + 归一：库一大、轮询一快，这条就是 O(全表) 的常数成本。缓存键取
   * `PRAGMA data_version`（SQLite 为"别的连接改过库"提供的廉价水位；本连接自己的写不推进
   * 它，故另配一个本地写计数）——两边都没变就复用上次的解析结果，语义与逐次重读完全一致
   * （归一规则、坏行跳过都在同一个 {@link LessonDb.readLessonRecords} 里）。
   */
  private cachedLessons(): LessonRecord[] {
    const key = `${String(this.dataVersion())}:${String(this.localWrites)}`;
    if (this.lessonCache?.key === key) {
      return this.lessonCache.rows;
    }
    const rows = this.readLessonRecords();
    this.lessonCache = { key, rows };
    return rows;
  }

  /** `PRAGMA data_version`：别的连接改过库就变。读不到（连接已关）按 0 处理——缓存随之
   *  每次失效，等于退回逐次重读，不会把旧数据当新数据。 */
  private dataVersion(): number {
    try {
      const row = this.db.prepare("PRAGMA data_version").get();
      const version = fieldOf(row, "data_version");
      /* v8 ignore next —— PRAGMA data_version 恒为整数，非 number 不可构造 */
      return typeof version === "number" ? version : 0;
    } catch {
      return 0;
    }
  }

  /** 全量有效教训（坏行跳过）。project 过滤放在调用方：计数需要不带过滤的全量。 */
  private readLessonRecords(): LessonRecord[] {
    const rows = this.db.prepare("SELECT payload FROM lessons ORDER BY id").all();
    return rows
      .map((row): LessonRecord | null => {
        const payload = fieldOf(row, "payload");
        if (typeof payload !== "string") {
          return null;
        }
        try {
          return normalizeLessonRow(JSON.parse(payload));
        } catch {
          return null;
        }
      })
      .filter((row): row is LessonRecord => row !== null);
  }

  /**
   * 会话台账排队：把一笔违规/遵守塞进**待计队列**（一次一笔，行 upsert）。
   *
   * 两点都是根因修法：
   *   - **读改写必须在事务里**。先前先 SELECT 再 UPSERT，两条语句之间别的进程也能写，
   *     后写的一方把先写的那笔整格覆盖掉（丢一笔计数，且没有任何日志）。这里用
   *     `BEGIN IMMEDIATE` 把读与写圈在一起。
   *   - **不再把 `settled_at` 重置成 NULL**。旧实现每次排队都把整行翻回"未落定"并带上
   *     历史全部 id，于是同一笔在下一轮清算被再计一次；队列语义下"有新的一笔"已经由
   *     数组非空表达。
   * 写失败只日志——台账是清算的输入，丢了顶多少记一次 suppressed，不能让上报路径炸。
   */
  public noteLedger(
    sessionId: string,
    project: string,
    kind: "violated" | "passed",
    ruleId: string,
  ): void {
    try {
      this.db.exec(BEGIN_SQL);
      try {
        const row = this.db
          .prepare(
            "SELECT violated, passed FROM session_ledger WHERE session_id = ? AND project = ?",
          )
          .get(sessionId, project);
        const violated = new Set(stringArrayOf(fieldOf(row, "violated")));
        const passed = new Set(stringArrayOf(fieldOf(row, "passed")));
        (kind === "violated" ? violated : passed).add(ruleId);
        this.db
          .prepare(this.noteLedgerSql())
          .run(
            sessionId,
            project,
            JSON.stringify([...violated]),
            JSON.stringify([...passed]),
            this.now(),
          );
        this.db.exec("COMMIT");
        this.localWrites += 1;
      } catch (error) {
        this.rollbackQuietly();
        throw error;
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} ledger write failed: ${errorText(error)}`);
    }
  }

  /** 本会话**还有事要做**的台账行：待计队列非空，或暴露度还没计过（后者只是让本进程
   *  的收尾能补上 exposure；补算侧另有 {@link LessonDb.pendingLedgerAll} 的判据）。 */
  public pendingLedger(sessionId: string): LedgerRow[] {
    return this.pendingRows(
      `SELECT session_id, project, violated, passed, settled_at, ${this.exposureColumn()} FROM session_ledger ` +
        "WHERE session_id = ? AND (settled_at IS NULL OR violated <> ? OR passed <> ?) " +
        "ORDER BY project",
      sessionId,
      EMPTY_IDS,
      EMPTY_IDS,
    );
  }

  /** 单行读取（**含已落定行**）：清算前用来辨认“这一场已经结清”的那条边。
   *  它与 `pendingLedger` 刻意分开：后者只返回还有事要做的行，已落定且队列空的行不在
   *  其中，但宿主仍需要知道“行存在且已消费”，以免把内存桶再写一遍。读失败按空处理，
   *  与其它读面一致（失败时留给下一次补算，不让清洗路径炸）。 */
  public ledgerRow(sessionId: string, project: string): LedgerRow | null {
    const rows = this.pendingRows(
      `SELECT session_id, project, violated, passed, settled_at, ${this.exposureColumn()} FROM session_ledger ` +
        "WHERE session_id = ? AND project = ?",
      sessionId,
      project,
    );
    return rows[0] ?? null;
  }

  /**
   * 启动补算的全表入口：一次读出**所有**队列非空的台账行，按 sessionId 由宿主逐会话清算。
   *
   * 原先只有按 sessionId 的 `pendingLedger`，而它的调用点全部依赖"本进程还看得见这场
   * 会话"；进程被 kill/崩溃后下一轮开机既没有 sessionWatch、也等不到 session/disposed，
   * pending 行就永久躺在库里。启动扫描必须从库这一侧主动找账。
   *
   * 只返回队列非空的行：补算走零暴露度（见 host 的 `recoverPendingLedgers`），"队列空但
   * 暴露度未计"的行补不了任何东西，扫进来只会每次开机白转一圈。
   */
  public pendingLedgerAll(): LedgerRow[] {
    return this.pendingRows(
      `SELECT session_id, project, violated, passed, settled_at, ${this.exposureColumn()} FROM session_ledger ` +
        "WHERE violated <> ? OR passed <> ? ORDER BY session_id, project",
      EMPTY_IDS,
      EMPTY_IDS,
    );
  }

  /** `pendingLedger` 与 `pendingLedgerAll` 共用的行归一：坏 project 跳过，JSON 坏列折空。 */
  private pendingRows(sql: string, ...params: readonly string[]): LedgerRow[] {
    try {
      const rows = this.db.prepare(sql).all(...params);
      return rows
        .map((row): LedgerRow | null => {
          const sessionId = fieldOf(row, "session_id");
          const project = fieldOf(row, "project");
          if (typeof sessionId !== "string" || typeof project !== "string") {
            return null;
          }
          const settledAt = fieldOf(row, "settled_at");
          const exposureAt = fieldOf(row, "exposure_at");
          return {
            sessionId,
            project,
            violated: stringArrayOf(fieldOf(row, "violated")),
            passed: stringArrayOf(fieldOf(row, "passed")),
            settledAt: typeof settledAt === "number" ? settledAt : null,
            exposureAt: typeof exposureAt === "number" ? exposureAt : null,
          };
        })
        .filter((row): row is LedgerRow => row !== null);
    } catch (error) {
      console.error(`${LOG_PREFIX} ledger read failed: ${errorText(error)}`);
      return [];
    }
  }

  /**
   * 在**规则计数所在的那个事务里**结清台账：把本次计过的 id 从队列里取走，队列空了打
   * `settled_at`，`countExposure` 且这个 (会话,项目) 还没计过暴露度时打 `exposure_at`。
   * 行不存在时**新建**（纯暴露度的那种清算没有队列，但"这一场是否已经计过 exposure"
   * 仍要落库，否则同一场会话被 resume 两次就涨两次 samples）。
   *
   * 这是"恰好一次"的全部机制：取走与计数在同一个 `BEGIN IMMEDIATE` 里提交，崩溃只会
   * 两个都没发生；另一条连接（另一进程补算 / 另一个 profile）抢先取走时，本方看到的
   * 队列已经不含那些 id，于是抛 {@link LedgerConsumedElsewhereError} 让整笔回滚——**不许**
   * 把同一笔计两遍。
   *
   * 暴露度**不抛**：`countExposure` 为真但 `exposure_at` 已有值时，只说明这一场的暴露度
   * 早先已经计过（重复的 dispose 边），本次要计的是新进队列的 suppressed——按"不再计
   * 暴露度"落笔即可，让调用方整笔回滚会把那些 suppressed 也丢掉。
   *
   * 由 `LessonStore.sessionEnded` 的同事务回调调用，故**不吞错**（吞掉就得到"规则计数
   * 已提交、台账仍 pending"的裂缝，下一次补算再计一遍）。
   * @param expected 本次计数依据的 id 集合（必须都还在队列里，否则判定被别处取走）
   * @param countExposure 本次是否要计暴露度（已计过则跳过）
   */
  public settleLedgerNow(
    sessionId: string,
    project: string,
    expected: { violated: readonly string[]; passed: readonly string[] },
    countExposure: boolean,
  ): void {
    const row = this.db
      .prepare(
        `SELECT violated, passed, settled_at, ${this.exposureColumn()} FROM session_ledger ` +
          "WHERE session_id = ? AND project = ?",
      )
      .get(sessionId, project);
    const violated = new Set(stringArrayOf(fieldOf(row, "violated")));
    const passed = new Set(stringArrayOf(fieldOf(row, "passed")));
    const missing =
      expected.violated.some((id) => !violated.has(id)) ||
      expected.passed.some((id) => !passed.has(id));
    // 行不存在不是“被别处取走”，而是这一场从头到尾没成功排队（noteLedger 写失败）：
    // 此时 expected 里的计数正来自内存桶，必须允许新建空行把它结清；否则
    // sessionEnded 会整笔回滚，内存条目永远卡在 pending。行存在但 expected 不在队列里
    // 仍按“已消费”抛错——那是真正的重复计数风险。
    if (missing && row !== undefined) {
      throw new LedgerConsumedElsewhereError(sessionId, project);
    }
    for (const id of expected.violated) {
      violated.delete(id);
    }
    for (const id of expected.passed) {
      passed.delete(id);
    }
    const now = this.now();
    const drained = violated.size === 0 && passed.size === 0;
    // 两个时间戳列都要按"数字或 NULL"绑参：`fieldOf` 交出的是 unknown，直接用会让
    // node:sqlite 的参数类型在编译期漏成 unknown（运行期也可能被当成字符串绑进去）。
    const settledAt = numberOrNull(fieldOf(row, "settled_at"));
    const exposureAt = numberOrNull(fieldOf(row, "exposure_at"));
    const nextExposureAt = countExposure && exposureAt === null ? now : exposureAt;
    const nextSettledAt = drained ? now : settledAt;
    const shared = [
      sessionId,
      project,
      JSON.stringify([...violated]),
      JSON.stringify([...passed]),
      nextSettledAt,
    ] as const;
    // 降级态（v1 库升级失败、没有 exposure_at 列）少绑一位，其余列序不变。
    const params = this.exposureColumnFlag() ? [...shared, nextExposureAt, now] : [...shared, now];
    this.db.prepare(this.settleLedgerSql()).run(...params);
    this.localWrites += 1;
  }
}

/** 库文件名（相对 `$DSH_HOME` 的 `data/lesson-loop/` 目录）。 */
export const LESSON_DB_FILE = "lesson-loop.db";

/** 台账行形状判据：`session_id` / `project` 必须是文本，其余可读字段按需取。
 *
 *  它属于**发布面**（`types/lib/lesson-db.d.ts` 导出），给外部读行的一侧一个统一的窄化入口；
 *  本文件的读路径（`pendingRows`）不复用它，而是就地做六字段归一——那里的输入直接来自
 *  `prepare().all()`，字段可能缺失或类型不对，需要"缺就补默认"而不是"整行不合格就丢"。
 *  两者语义不同（判据 vs 归一），不要为了消除"只有测试在用的导出"把读路径改成调它：
 *  那会把"一行坏字段"从"跳过这一格"升级成"整行不算台账"。 */
export function isLedgerRow(value: unknown): value is LedgerRow {
  return (
    isRecord(value) &&
    typeof value["sessionId"] === "string" &&
    typeof value["project"] === "string"
  );
}

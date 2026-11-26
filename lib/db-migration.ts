// db-migration：把旧介质里的两块状态搬进 SQLite 库（一次性、幂等）。
//
// 旧介质两块：
//   1. 规则库 —— profile 的 `cordis.patch.yml` 里 `lesson-loop.rules` 数组。该字段已从
//      Config schema 摘除（用户拍板），插件不再读写它；迁移只把这段原文**读一次**、搬进
//      库，**不回写**：清空那一笔会以未知字段被宿主 `update` 拒掉，而抹掉用户原文也没有
//      好处——它留在文档里正好是"库丢了还能再导入"的最后一份存量。
//   2. 教训流水 —— `$DSH_HOME/cache/lesson-loop/events.jsonl`。搬法：库为空时逐行导入
//      （坏行跳过，与原读侧同一归一规则），成功后把文件改名 `events.jsonl.bak` 不再写入。
//      改名而不是删除：流水是派生物，但"哪些教训被读过"是人工排查的证据，留着不占运行
//      路径；`.bak` 也让人一眼看出它已退役。
//
// 幂等靠库内状态与文件存在性：规则库只搬"库为空"那一次（之后 patch 里再有值也不反向
// 覆盖库）；流水只在库为空且文件存在时导入。迁移失败（端口读失败/写回执不是 persisted/
// 改名失败）只记一条日志，不阻断装载——下一次开机再试。
//
// 三条判据都是**回执**而不是"调用过了"，各自对应一处返工过的根因：
//   - 规则库：`save` 的回执必须是 `persisted` 才算搬成。旧实现 `void db.rules.save(...)`
//     丢掉回执，再拿 `rulesCount() > 0` 当成功——并发冲突时旧卡一张没进，而库里原本非空
//     也照样报"搬好了"。
//   - 流水守卫：用 meta 的 `lessons_migrated` 标记，而不是 `hasLessons()`（库里有任意一条
//     新教训就短路重试）。失败后用户先写了新流水时，旧文件仍必须能补导；成功后才写标记。
//   - 流水导入：按 `MIGRATION_IMPORT_BATCH` 分批调用 `importLessons(records, skip, limit)`
//     并累计**实际提交**的条数。整份文件塞进一条事务时，同机其它 profile 的写会整段撞
//     `busy_timeout`；判据仍是"每条都进了库"，任何一批回滚就保留源文件不改名。

import { existsSync, renameSync } from "node:fs";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import type { LessonDb } from "./lesson-db.ts";
import { readJsonl } from "./lesson-jsonl.ts";
import { normalizeLessonRow } from "./lesson-store.ts";
import type { LessonRecord, RulesRepository } from "./lesson-store.ts";

const LOG_PREFIX = "[lesson-loop]";

/** 迁移时单批导入的教训条数。取 200：一条事务的锁窗口保持在毫秒级，同时把
 *  "整份文件一条事务"造成的长时间排他写拆开（同机其它 profile 的写不必等整份历史）。
 *  导出而不是让测试抄字面值：多批场景的用例要按它构造。 */
export const MIGRATION_IMPORT_BATCH = 200;

/** 规则库搬迁的 CAS 重放次数（与 LessonStore 的 RULES_CAS_RETRY_LIMIT 同量级）。 */
const RULES_MIGRATION_RETRY = 3;

/** 迁移依赖：库、旧规则端口（可为 null：宿主没有 settings CAS 面）、流水文件路径。 */
export interface DbMigrationArgs {
  readonly db: LessonDb;
  readonly legacy: RulesRepository | null;
  readonly eventsFile: string;
}

/**
 * 规则库：库空 → 从旧端口整片搬入；**不清空、不回写**旧数组（字段已摘除，写不进去，
 * 留着也是重新导入的最后一份存量）。
 *
 * 成功判据只看写回执。冲突（同机另一个进程刚好也在写库）重读 revision 再试有限次，
 * 仍不成就返回 false 让下一次开机再来——**不**把"库现在非空"当成自己搬成功的证据。
 */
function migrateRules(db: LessonDb, legacy: RulesRepository | null): boolean {
  if (legacy === null) {
    return false;
  }
  try {
    const read = legacy.load();
    if (!read.usable) {
      // 旧端口读不懂（用户把 rules 手改成非数组一类）：不动它，等人工修。
      return false;
    }
    if (read.cards.length === 0) {
      return false;
    }
    if (db.rulesCount() > 0) {
      // 库里已有规则：迁移只服务"库为空"那一次，绝不覆盖用户后来的编辑。
      return false;
    }
    for (let attempt = 0; attempt < RULES_MIGRATION_RETRY; attempt += 1) {
      const outcome = db.saveRulesNow(read.cards, db.revision());
      if (outcome === "persisted") {
        return true;
      }
      if (outcome === "rejected") {
        // 写被拒（库只读/连接已关/行写失败）：重试没有意义。
        return false;
      }
      // conflict：别的连接在我们读和写之间推进了 revision，重读再试。
    }
    console.warn(`${LOG_PREFIX} rule migration gave up after repeated revision conflicts`);
    return false;
  } catch (error) {
    console.error(`${LOG_PREFIX} rule migration failed: ${errorText(error)}`);
    return false;
  }
}

/** 流水：未完成迁移且文件存在时逐行导入；成功后改名 `.bak`（已存在同名备份则只保留原文件）
 *  并写 `lessons_migrated` 标记。
 *
 *  "成功"的判据是**每一条都进了库**，不是"循环跑完了"：`importLessons` 把一批插入包在
 *  一个事务里并按实际提交条数回执，任一批写失败就整批回滚、返回 0。少了这条判据，
 *  磁盘满/触发器拒绝等单行失败会被"循环结束"掩盖，源文件照样改名，剩下没写进去的
 *  教训就永久跳过（下一次开机看到库里非空直接不再导入）。
 *
 *  守卫（已完成标记 / 文件不存在）也放进 try：meta 读取失败时抛出，
 *  不能让它穿出 `migrateToDb`（文件头承诺"失败只日志不抛"）。
 */
function migrateLessons(db: LessonDb, eventsFile: string): boolean {
  try {
    if (!existsSync(eventsFile)) {
      return false;
    }
    if (db.lessonsMigrated()) {
      // 旧文件已经完整导入过：即使之后用户写了新教训、源文件因已有备份而留在原地，
      // 也不能再按“库非空”的旧守卫短路重试（那样失败后新写一条就永远不再补导）。
      return false;
    }
    // 逐行解析直接用旧读侧那一份 `readJsonl`：坏行跳过、非对象跳过、读不到与没有分开
    // （ENOENT 静默空表、其余 IO 错误按文件去重 warn 一次），以及解析缓存。这里另写一份
    // split/trim/JSON.parse 的话，"坏行会不会被计数"与"读不到是不是被当成空文件"两处判据
    // 就会各说一套——而这两处正是最容易悄悄改变迁移结论的地方。
    const records = readJsonl(eventsFile)
      .map((value) => normalizeLessonRow(value))
      .filter((row): row is LessonRecord => row !== null);
    if (records.length === 0) {
      // 没有一条能归一：保留原文件等人工修，别把"全坏"的文件改名成 .bak 当成功。
      console.warn(`${LOG_PREFIX} lesson events file has no importable record: ${eventsFile}`);
      return false;
    }
    let imported = 0;
    // 去重集合只读一次库：此后每批用内存集合判重，不再让每条记录跑一次
    // `WHERE NOT EXISTS` 的 `SCAN lessons`。集合只在整批提交成功后由 importLessons
    // 写回，失败回滚不会留下“已判重但没入库”的假记录。
    const seen = db.lessonPayloads();
    while (imported < records.length) {
      const batch = db.importLessons(records, imported, MIGRATION_IMPORT_BATCH, seen);
      if (batch === 0) {
        // 这一批整批回滚：源文件必须保留，下一次开机重试。
        console.error(
          `${LOG_PREFIX} lesson migration aborted: imported ${String(imported)}/${String(records.length)}, source kept`,
        );
        return false;
      }
      imported += batch;
    }
    const backup = `${eventsFile}.bak`;
    if (existsSync(backup)) {
      // 备份已存在：不再将原文件改名（改名会覆盖用户上一轮的备份），原文件保留。
      console.warn(
        `${LOG_PREFIX} lesson events imported (${String(imported)}), backup already exists: ${backup}`,
      );
      db.markLessonsMigrated();
      return true;
    }
    renameSync(eventsFile, backup);
    db.markLessonsMigrated();
    console.info(
      `${LOG_PREFIX} lesson events imported into rule database (${String(imported)}) — old file renamed .bak`,
    );
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} lesson migration failed: ${errorText(error)}`);
    return false;
  }
}

/**
 * 跑两块迁移。**同步完成库侧写入**（SQLite 的写核是同步实现，`save` 的 Promise 只是契约
 * 外壳）；两块都**不回写**旧介质（规则字段已摘除、流水文件保留原样或改名 .bak）。
 * 任一步失败都只日志、不抛（装载期不该因磁盘/设置竞态失败）。
 * 返回是否**动过**任何一块（测试据此断言幂等；生产不看返回值）。
 */
export function migrateToDb(args: DbMigrationArgs): boolean {
  let touched = false;
  touched = migrateRules(args.db, args.legacy) || touched;
  touched = migrateLessons(args.db, args.eventsFile) || touched;
  return touched;
}

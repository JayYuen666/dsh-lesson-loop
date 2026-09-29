// rules-namespace：规则库的官方存放面——本条目设置命名空间里的 `rules` 数组字段。
//
// 为什么从"自管 $DSH_HOME/metrics/lesson-loop-rules.json"搬到 settings：
//   1. dsh 承认的用户数据目录只有 settings 文档与 sessions/storages/cache/logs，
//      插件自开 `metrics/` 属越界（用户手工编辑、备份、清理都不在官方面上）；
//   2. settings provider 已自带跨进程写锁（atomic-write 的 .lock 兄弟文件）、
//      逐 namespace 合并与"外部编辑热加载"，规则库正是需要这三件事的状态面。
//
// 0.1.7 起规则数组与开关**同属一段**（`lesson-loop`），这不是妥协而是唯一形态：宿主
// 的设置面按 profile 条目建模（一个条目一份 `Config`、一个命名空间 = 条目 id），
// 插件侧的 `settings.register`/`get`/`installSection` 已整体移除——再开一段就等于再造
// 一个插件条目。旧那条"分属两段"的理由（provider 用 `schema(mergeLayers(base, section))`
// 校验，坏存量把 register 打回、连带打死另一段）在 0.1.7 换了一种触发方式，因此也换了
// 一道闸门，见下面 RulesFieldSchema 的 `.loose()` 与 load() 的 user 层判定。
//
// 读写口径（LessonStore 的 RulesRepository 实现）：
//   读 —— `describe()` 里本条目那一条：`value` 是 cordis 解析后的当前值（volatile 字段
//         已全部折成普通数据），`user` 是 profile 文档里那一层的原文，`revision` 是它的
//         单调版本号；三者同一次同步读取，天然成对。
//   写 —— provider 层 `update(ns, patch, expectedRevision)`：带 CAS 的 merge 写，数组键
//         整片覆盖（mergeLayers 不数组合并），revision 被别处推进过则抛
//         SettingsConflictError（由 LessonStore 重读重放）。
// ⚠ 一段一个 revision：设置卡保存开关与规则库提交共用同一枚版本号，撞上了就是一次
//   conflict → 重读 → 重放（RULES_CAS_RETRY_LIMIT 之内），不是错误而是常态。

import Schema from "@deepseek-ai/schemastery";
// 规则库读写口绑官方声明（type-only：运行时服务由 ctx 注入，值导入会破坏 host.js 自包含）。
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
import { errorText } from "@jayyuen666/dsh-plugin-shared/lib/errors";
import type { RuleCard, RulesRead, RulesRepository, RulesWriteOutcome } from "./lesson-store.ts";
// 段名与 `rules` 字段名（以及"解析值 → 卡数组"那一步投影）在 lib/rules-layout.ts：本文件是
// 端口实现，坐标是另一端，两边各改各的就会长成"卡片绑的段 ≠ 这里读的段"。
import { RULES_FIELD, SETTINGS_NAMESPACE, cardsOfValue } from "./rules-layout.ts";
import { fieldOf } from "@jayyuen666/dsh-plugin-shared/lib/record";

/**
 * 单字段声明：类型判定**不在这里**发生。
 *
 * 收窄由 lib/lesson-store.ts 的 normalizeRuleCardRow 逐字段负责（既有口径：一条
 * 漂移记录不许拖垮整条总线）。schema 若把字段声明成强类型，用户手改一个
 * `occurrences: "3"` 就会让整片规则库读不出来——比旧实现更差的退化，故这里只
 * 声明"有哪些字段"（给配置面与 describe().schema 看），判定留给读取侧。
 */
const cardField = Schema.any();

/** 规则卡的形状声明（与 lib/lesson-store.ts 的 RuleCard 字段一一对应）。 */
const RuleCardSchema = Schema.object({
  id: cardField,
  project: cardField,
  cwd: cardField,
  category: cardField,
  signature: cardField,
  statement: cardField,
  status: cardField,
  createdAt: cardField,
  updatedAt: cardField,
  armedAt: cardField,
  occurrences: cardField,
  sources: cardField,
  violation: cardField,
  suppressed: cardField,
  samples: cardField,
  recurrences: cardField,
  lastSeenAt: cardField,
  lastViolationAt: cardField,
  lastSuppressedAt: cardField,
  evidence: cardField,
  origin: cardField,
});

/**
 * 规则库字段：本条目 `Config` 里的一个 volatile 数组（空库 = `[]`）。
 *
 * 三段各有理由，改之前逐段读：
 *   - `.volatile()`：0.1.7 只有标了 volatile 的字段会被宿主投影成设置表单并允许写入
 *     （packages/settings/settings/src/schema.ts:37-47 + index.ts:308-309/386）。规则库
 *     要活读写，这一层不能省；也因此**没有**"注册被打回"这条路了——条目 Config 的校验
 *     发生在 cordis 装载期（vendor/cordis/src/fiber.ts:50-61 resolveConfig 抛
 *     ValidationError → :645-668 整个条目不执行），插件侧无处 catch。
 *   - `.loose()`：正是为了接住上一条。用户把 `rules` 手改成非数组（`rules: 乱码`）时，
 *     数组类型判定会抛——**同段**的开关连同整条总线会跟着这个条目一起不加载。`.loose()`
 *     让子树判定失败退到该字段的默认值（vendor/schemastery/src/index.ts:551），条目照常
 *     装载，坏值只影响规则库自己。"读不懂"另有判定，见 load()。
 *   - `.default([])`：0.1.7 没有 base 层，原 RULES_BASE 的 `{ rules: [] }` 就落在这里。
 *     数组是**整片覆盖**（mergeLayers 不数组合并），所以默认值必须是完整值——空库的完整
 *     值就是 `[]`。schemastery 给 array 预置的 meta.default 本来就是 `[]`，显式写出是为了
 *     让"底座 → 默认"这条映射在 schema 上看得见。
 */
export const RulesFieldSchema = Schema.array(Schema.union([RuleCardSchema, cardField]))
  .loose()
  .default([])
  .volatile();

/**
 * 规则库读写口 = 官方 `SettingsForms`（installed @deepseek-ai/dsh-settings/lib/types/
 * index.d.ts:62，cordis `Service` 子类 + private 字段 → 名义比较）的两位成员投影：
 * - `update` **整体**取官方成员（:102 `update(ns: string, patch: object, expectedRevision?:
 *   number): Promise<void>`），签名一个字都不重述。`ns` 官方就是裸 `string`（品牌
 *   `SettingsNamespace` 只出现在 :43 的冲突错误与 :73 的事件载荷上），故本包不为它造品牌。
 * - `describe` 只把**入参**绑官方（:96 那个可选的 `SettingsDescribeOptions`，:21-23），
 *   返回域留 `readonly unknown[]`。这不是偷懒：本包对这一行的全部工作就是判"读不读得懂"
 *   （`value`/`user`/`revision` 三位分别对应"解析值 / 文档原文 / CAS 版本"，任一不合形状
 *   都要退成 unusable 而不是猜），而 test/lesson-store.test.ts 钉的正是**契约外交付**——
 *   `revision: "3"`（字符串）、整段是字符串、看不见该命名空间那一行。把返回收成官方
 *   `SettingsDescriptor[]` 等于宣称"交付必然可信"，那几条用例就无法表达，而为过类型删用例
 *   是本仓红线。旧镜像的问题是另一头：它连 `describe` 的**入参**和 `update` 的签名都自己
 *   编了一遍（`describe: () => readonly unknown[]` 丢了 options 位），官方改形状时无人报警。
 */
export interface SettingsCasSurface {
  describe: (options?: Parameters<SettingsForms["describe"]>[0]) => readonly unknown[];
  update: SettingsForms["update"];
}

/** 命名空间描述符的最小投影：value（解析值）+ user（文档原文）+ revision。 */
interface RulesDescriptor {
  readonly value: unknown;
  readonly user: unknown;
  readonly revision: number;
}

/**
 * SettingsConflictError 的判定：不值导入 @deepseek-ai/*（本插件只 type-only 用它），
 * 按官方类的两个稳定成员认（`code === 'SETTINGS_CONFLICT'` 是给人映射的机器码，
 * `name` 是类名兜底）。认出来才谈重试——其它错误重试也不会变好。
 */
function isSettingsConflict(error: unknown): boolean {
  return (
    fieldOf(error, "code") === "SETTINGS_CONFLICT" ||
    fieldOf(error, "name") === "SettingsConflictError"
  );
}

/**
 * user 层里的 `rules` 键是不是"人改坏的形状"（存在、但不是数组）。
 *
 * 这就是 0.1.7 版的"注册被存量坏数据打回"判定：`.loose()` 让 cordis 把坏值解析成 `[]`，
 * 于是 value 层看着完全合法——只盯 value 就会把"我读不懂"当成"别人确实没写过"，下一次
 * 提交顺手把整段（连人还没修好的那部分一起）覆掉。`describe().user` 是文档原文那一层
 * （宿主用 projectForm(form, override) 投出来，只丢 undefined、不做类型修正），坏值在
 * 那里现形。修好之后这条判定自然放行，不必重启（热加载）。
 */
function rulesCorrupted(user: unknown): boolean {
  const raw = fieldOf(user, RULES_FIELD);
  return raw !== undefined && !Array.isArray(raw);
}

/** 不可用回执：读返回空、写一律拒绝（调用方按 persist-failed 语义处理）。 */
const UNUSABLE_READ: RulesRead = { revision: 0, cards: [], usable: false };

/** 没有可用 CAS 面（provider 缺位 / 该段读不出可信值）时的规则库端口。 */
function unavailableRulesRepository(): RulesRepository {
  return {
    load: (): RulesRead => UNUSABLE_READ,
    // 端口契约要求 Promise 回执（RulesRepository.save），而这里没有任何要等的东西：
    // 直接给一个已 fulfil 的 Promise，而不是空转的 async 箭头。
    save: (): Promise<RulesWriteOutcome> => Promise.resolve("rejected"),
  };
}

/**
 * 建规则库端口。
 * @param surface provider 面；null = 该命名空间不可用（宿主没有 CAS 面）。
 */
export function createRulesRepository(surface: SettingsCasSurface | null): RulesRepository {
  if (surface === null) {
    return unavailableRulesRepository();
  }
  const findDescriptor = (): RulesDescriptor | null => {
    const found = surface.describe().find((item) => fieldOf(item, "ns") === SETTINGS_NAMESPACE);
    if (found === undefined) {
      return null;
    }
    const revision = fieldOf(found, "revision");
    return {
      value: fieldOf(found, "value"),
      user: fieldOf(found, "user"),
      revision: typeof revision === "number" ? revision : 0,
    };
  };
  // "坏存量"只在"从读得懂翻成读不懂"那一刻报一次。装载期报不了：apply 跑在自己那条
  // fiber 变 ACTIVE 之前，那一刻 describe() 里没有本条目的行（真实宿主隔离实测），于是
  // 每次正常开机都只会得到"时序未到"这一支——把那句话改成 error 也仍是每次开机刷一条，
  // 而真正的坏形状反而没人说。第一次看得见坏形状的调用点是这里：卡片轮询 stats、总线
  // 收 report、规则动作落库都走 load()。
  let corruptReported = false;
  const reportCorruption = (corrupt: boolean): void => {
    if (corrupt && !corruptReported) {
      corruptReported = true;
      console.error(
        `[lesson-loop] rules namespace rejected: "${SETTINGS_NAMESPACE}.rules" is not an array — rule library reads empty and refuses writes (switches still work)`,
      );
    } else if (!corrupt) {
      // 修好了就重新武装：下次再坏要再报（不依赖重启）。
      corruptReported = false;
    }
  };
  return {
    load(): RulesRead {
      try {
        const found = findDescriptor();
        // 条目被摘掉（热卸载竞态）= 看不见这一段，或 user 层的 rules 是人改坏的形状
        // = 读不懂这一段：两种都按"不可用"处理，绝不退成空库再写回去——那等于替别的
        // 进程刚写的规则库背书、或替那段等人修坏数据盖章。
        const corrupt = found !== null && rulesCorrupted(found.user);
        reportCorruption(corrupt);
        return found === null || corrupt
          ? UNUSABLE_READ
          : { revision: found.revision, cards: cardsOfValue(found.value), usable: true };
      } catch (error) {
        console.error(`[lesson-loop] rules read failed: ${errorText(error)}`);
        return UNUSABLE_READ;
      }
    },
    async save(cards: readonly RuleCard[], revision: number): Promise<RulesWriteOutcome> {
      try {
        // 整段替换 rules 键（mergeLayers 对数组是整体覆盖），故传入的数组必须
        // 来自"写这一刻"的读取——见 LessonStore.commit 的 CAS 纪律。
        await surface.update(SETTINGS_NAMESPACE, { [RULES_FIELD]: [...cards] }, revision);
        return "persisted";
      } catch (error) {
        if (isSettingsConflict(error)) {
          return "conflict";
        }
        console.error(`[lesson-loop] rules write failed: ${errorText(error)}`);
        return "rejected";
      }
    },
  };
}

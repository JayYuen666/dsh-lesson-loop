// 规则库设置面的测试替身：复刻 0.1.7 dsh settings 服务对本插件要紧的三件事。
//
//   1. **注册是隐式的**：0.1.6 的 `settings.register(ns, schema, { base })` 已被宿主移除，
//      命名空间 = profile 条目 id、可编辑字段 = 条目 Config 里标了 `.volatile()` 的那几项。
//      本假件因此按「条目 id → 文档里那一层原文」建模，并用**本包真实导出的 Config**
//      （host.ts 的 `plugin.Config`）经 standard-schema 解析（cordis 装载期走的就是这条
//      路，vendor/cordis/src/fiber.ts:50-61）——`.default()` 底座、`.loose()` 吸收坏
//      `rules`、volatile 引用形态全都与宿主同源，不在测试里另抄一份默认值。
//   2. `describe()` 一行给三样：`value`（解析后的当前值，volatile 引用已摊平成普通数据）、
//      `user`（文档原文那一层，宿主用 projectForm(form, override) 投出来）、`revision`。
//      规则库靠 value 读卡、靠 revision 做 CAS、靠 user 分辨「读不懂」与「真的没有」。
//   3. `update(ns, patch, expectedRevision)` —— 带 CAS 的 merge 写，数组键整片覆盖；
//      revision 已变则抛 SettingsConflictError 形状的错误。
//
// 为什么不用真 provider：真的一路要文件、watcher、写锁，而本包要验的是"两个进程
// 交替写同一段设置时不互相抹卡"这条纪律——把它做成 revision 可推进的内存假件，
// 反而是能稳定复现丢卡场景的最小面。
//
// 本文件另附两个 LessonStore 用的规则库端口构造器（持久化边界已从"自管 JSON 文件"
// 换成 RulesRepository，测试侧的装配因此也走这里）：
//   * attachRulesRepository —— 生产同款端口装配（0.1.7 无注册步骤，就一句 createRulesRepository）；
//   * scriptedRulesRepository —— 手工排布读面与写回执，并逐次记账（断言"根本没
//     调用过 save"这类不变式时不需要真 provider）。

import plugin from "../host.ts";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SettingsDescriptor, SettingsNamespace } from "@deepseek-ai/dsh-settings";
// 段名 / 字段名 / 值→卡投影取 lib/rules-layout.ts（存放面坐标），端口构造取
// lib/rules-namespace.ts（CAS 实现）：与生产侧同一处分法，假件不另立第二套坐标。
import { RULES_FIELD, SETTINGS_NAMESPACE, cardsOfValue } from "../lib/rules-layout.ts";
import { createRulesRepository } from "../lib/rules-namespace.ts";
import type {
  RuleCard,
  RulesRead,
  RulesRepository,
  RulesWriteOutcome,
} from "../lib/lesson-store.ts";

/** 官方 SettingsConflictError 的测试替身（provider 靠它区分"该重试"与"写不进去"）。
 *  认的仍是它的 `code === "SETTINGS_CONFLICT"`——isSettingsConflict 的两个判据里，
 *  name 那条按 unicorn/custom-error-definition 要求跟类名一致。 */
class FakeSettingsConflictError extends Error {
  public readonly code = "SETTINGS_CONFLICT";
  public readonly expected: number;
  public readonly actual: number;

  public constructor(ns: string, expected: number, actual: number) {
    super(
      `settings namespace "${ns}" changed since it was read (revision ${String(expected)} → ${String(actual)})`,
    );
    this.name = "FakeSettingsConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** 值级深冻结（官方 resolve 后 deepFreeze）：读到别处对象就地改 = 立刻炸，不留隐性共享。 */
function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze(Reflect.get(value, key));
    }
    Object.freeze(value);
  }
  return value;
}

/** 纯数据深拷贝：写侧快照 + 读侧隔离（真 provider 用 cloneJsonShaped 同效）。 */
function detach<Value>(value: Value): Value {
  return structuredClone(value);
}

/** 对象守卫（本包统一风格）。 */
function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 数组守卫：`Array.isArray` 只把值收成 `any[]`，读原文要的是 `unknown[]`。 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** mergeLayers 的等价实现：普通对象递归合并，数组与其它值整体覆盖。 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) {
    return under;
  }
  if (!isPlain(under) || !isPlain(over)) {
    return over;
  }
  const merged: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value;
  }
  return merged;
}

/** 摊平 volatile 引用（packages/settings/settings/src/schema.ts:10-17 plainConfig 同语义）：
 *  宿主 describe() 交给插件的 value 就是这样一份普通数据，引用本身不出这扇门。 */
function plainConfig(value: unknown): unknown {
  const candidate = value as { get?: () => unknown };
  if (isPlain(value) && typeof candidate.get === "function") {
    // 引用形态判定：官方 `Volatile` 的**读面**只有 `get()`（vendor/cosmokit/src/volatile.ts:9-11），
    // 写面另挂在 symbol 键 `[write]` 上（同文件 :14-16 的 WritableVolatile、:39-45 的
    // createVolatile 返回值）。按 `get()` 判形状能同时覆盖只读与可写两种引用；
    // 不值导入 cordis/cosmokit。
    return plainConfig(candidate.get());
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => plainConfig(item));
  }
  if (isPlain(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, plainConfig(child)]),
    );
  }
  return value;
}

/** 解析一层文档原文 = cordis 装载期的同一件事（填默认、`.loose()` 吸收坏值、包引用）。 */
function resolveSection(section: Record<string, unknown>): Record<string, unknown> {
  const result = plugin.Config["~standard"].validate(detach(section)) as {
    issues?: readonly unknown[];
    value?: unknown;
  };
  if (result.issues !== undefined && result.issues.length > 0) {
    // 真宿主在这里抛 ValidationError → 整个条目不加载。假件也炸，别让坏 config 悄悄通过。
    throw new TypeError(`entry config rejected by schema: ${JSON.stringify(result.issues)}`);
  }
  const plain = plainConfig(result.value);
  return deepFreeze(isPlain(plain) ? plain : {});
}

/** 规则库假件的对外面（测试侧钩子齐在 SettingsProviderFake 上）。 */
export interface SettingsProviderFake {
  describe: () => SettingsDescriptor[];
  update: (ns: string, patch: object, expectedRevision?: number) => Promise<void>;
  /** 模拟外部（另一进程/用户手改）把某命名空间的 user 段换掉：热加载式重解析并推进 revision。 */
  externalSet: (ns: string, section: Record<string, unknown>) => void;
  /** 让接下来 times 次写以 SettingsConflictError 失败（读后 revision 被别处推进）。 */
  forceConflicts: (times: number) => void;
  /** 让接下来 times 次写以普通错误失败（provider/磁盘写不进去）。 */
  failWrites: (times: number) => void;
  /** 文档原文那一层（未写过的段 = undefined）：`user` 侧断言与开关翻动都读它。 */
  peek: (ns: string) => Record<string, unknown> | undefined;
  /** 解析后的当前值（= describe().value 同一份，但不计入 loads）。 */
  resolvedOf: (ns: string) => Record<string, unknown>;
  revisionOf: (ns: string) => number;
  writesOf: (ns: string) => number;
  loadsOf: (ns: string) => number;
}

/** 文档里那一层的形状校验（0.1.7 的条目 config 必须是键值对象）。 */
function sectionOf(document: Record<string, unknown>, ns: string): Record<string, unknown> {
  const raw = document[ns];
  if (raw === undefined) {
    return {};
  }
  if (!isPlain(raw)) {
    throw new TypeError(`settings section "${ns}" must be an object of keys`);
  }
  return raw;
}

/**
 * 建 provider 假件。
 * @param initial 装载时就躺在文档里的条目段（含坏存量场景）。
 */
export function makeSettingsProvider(
  initial: Record<string, Record<string, unknown>> = {},
): SettingsProviderFake {
  const document: Record<string, unknown> = detach(initial);
  const revisions = new Map<string, number>();
  const knobs = { conflicts: 0, failures: 0 };
  const counters = new Map<string, { writes: number; loads: number }>();

  const counterFor = (ns: string): { writes: number; loads: number } => {
    const existing = counters.get(ns);
    if (existing !== undefined) {
      return existing;
    }
    const created = { writes: 0, loads: 0 };
    counters.set(ns, created);
    return created;
  };

  const bump = (ns: string): void => {
    revisions.set(ns, (revisions.get(ns) ?? 0) + 1);
  };

  /**
   * 落一层新段内容，**保持对象身份**：host.test 的 `ctx.value` 拿的就是这一层原文，
   * 整对象换掉会让"装载后翻开关"那几条断言悄悄翻在一份没人再看的对象上（假绿）。
   */
  const storeSection = (ns: string, next: Record<string, unknown>): void => {
    const held = document[ns];
    if (!isPlain(held)) {
      document[ns] = next;
      return;
    }
    for (const key of Object.keys(held)) {
      Reflect.deleteProperty(held, key);
    }
    Object.assign(held, next);
  };

  const write = async (ns: string, input: object, expectedRevision?: number): Promise<void> => {
    if (knobs.conflicts > 0) {
      knobs.conflicts -= 1;
      throw new FakeSettingsConflictError(ns, expectedRevision ?? -1, (revisions.get(ns) ?? 0) + 1);
    }
    if (knobs.failures > 0) {
      knobs.failures -= 1;
      throw new Error(`provider refused the "${ns}" write`);
    }
    const current = sectionOf(document, ns);
    // 官方口径：CAS 判定发生在写队列前缘、比较"此刻"的 revision，且改动一律基于
    // 此刻的段（不是调用方手里那份快照）。
    const revision = revisions.get(ns) ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new FakeSettingsConflictError(ns, expectedRevision, revision);
    }
    const next = mergeLayers(current, detach(input)) as Record<string, unknown>;
    // 解析不过的新段 = 真宿主那里条目不加载；假件同步炸，坏 rules 场景由 .loose() 吸收。
    storeSection(ns, next);
    resolveSection(next);
    bump(ns);
    counterFor(ns).writes += 1;
  };

  return {
    describe() {
      // 0.1.7 的 describe() 只投影"条目存在且至少一个 volatile 字段"的那些行；本假件
      // 只服务本包条目，故恒给这一条（跨命名空间读 locale 因此落空 = 未装 client-locale）。
      // 行形状就此是官方 `SettingsDescriptor`（installed dsh-settings/lib/types/index.d.ts:8-19，
      // 必填 ns/autoGenerate/schema/value/revision/applies）：`ns` 是品牌
      // `SettingsNamespace`（types.d.ts:5），构造口只有官方 `brandString`（恒等函数），
      // 假件也不走 `as` 绕行。
      const ns = brandString<SettingsNamespace>(SETTINGS_NAMESPACE);
      counterFor(ns).loads += 1;
      const raw = document[ns];
      return [
        {
          ns,
          autoGenerate: false,
          schema: null,
          value: resolveSection(sectionOf(document, ns)),
          user: isPlain(raw) ? { ...raw } : raw,
          revision: revisions.get(ns) ?? 0,
          applies: "live" as const,
        },
      ];
    },
    update: (ns, patch, expectedRevision) => write(ns, patch, expectedRevision),
    externalSet(ns, section) {
      storeSection(ns, { ...sectionOf(document, ns), ...detach(section) });
      bump(ns);
    },
    forceConflicts(times) {
      knobs.conflicts = times;
    },
    failWrites(times) {
      knobs.failures = times;
    },
    peek(ns) {
      const raw = document[ns];
      return isPlain(raw) ? raw : undefined;
    },
    resolvedOf(ns) {
      return resolveSection(sectionOf(document, ns));
    },
    revisionOf(ns) {
      return revisions.get(ns) ?? 0;
    },
    writesOf(ns) {
      return counters.get(ns)?.writes ?? 0;
    },
    loadsOf(ns) {
      return counters.get(ns)?.loads ?? 0;
    },
  };
}

// ── LessonStore 的规则库端口装配 ────────────────────────────────────────

/**
 * 生产同款的端口装配（镜像 host.ts 的 createRulesFacet）。0.1.7 起这里没有注册步骤可
 * 被打回：坏存量由条目 Config 的 `.loose()` 在解析期吸收，端口在 load() 里报 usable:false
 * ——"读不懂不等于没有"这条纪律因此换了个落点，而不再换了有无。
 */
export function attachRulesRepository(provider: SettingsProviderFake): RulesRepository {
  return createRulesRepository(provider);
}

/** 规则库测试面：provider 假件 + 可直接交给 LessonStore 的端口。 */
export interface RulesFacet {
  /** 底层 provider 假件（推进 revision、制造冲突与写失败、看写次数）。 */
  readonly provider: SettingsProviderFake;
  /** 交给 LessonStore 的持久化端口。 */
  readonly repo: RulesRepository;
  /** 模拟"另一个进程 / 用户手改"整片替换规则段（热加载路径，revision +1）。 */
  setExternally: (rows: readonly unknown[]) => void;
  /** 此刻真存进段落的卡（逐字段归一后；等价旧实现里"重读磁盘文件"的断言）。 */
  persisted: () => RuleCard[];
  /** 段落的 revision。 */
  revision: () => number;
  /** 段落的 rules 原文（未归一）：坏数据路径要能证明没被空库覆写掉。 */
  rawRules: () => readonly unknown[];
}

/**
 * 建一个空/存量规则库面。
 * @param initialRows 存量行（等价旧写的 `rules.json` 内容）：装载时即解析出来。
 */
export function makeRulesFacet(initialRows: readonly unknown[] = []): RulesFacet {
  const initialSection = { [RULES_FIELD]: [...initialRows] };
  const provider = makeSettingsProvider({ [SETTINGS_NAMESPACE]: initialSection });
  const repo = attachRulesRepository(provider);
  return {
    provider,
    repo,
    setExternally: (rows) => {
      provider.externalSet(SETTINGS_NAMESPACE, { [RULES_FIELD]: [...rows] });
    },
    persisted: () => cardsOfValue(provider.peek(SETTINGS_NAMESPACE)),
    revision: () => provider.revisionOf(SETTINGS_NAMESPACE),
    rawRules: () => {
      const section = provider.peek(SETTINGS_NAMESPACE);
      const rows = section?.[RULES_FIELD];
      return isUnknownArray(rows) ? rows : [];
    },
  };
}

/** 一次 save 的记账：写入的数组与作 CAS 条件的 revision。 */
export interface SavedBatch {
  readonly cards: readonly RuleCard[];
  readonly revision: number;
}

/** 缺省读面：可用空库（写走 revision 0）。 */
const OPEN_READ: RulesRead = { revision: 0, cards: [], usable: true };

/** 手工端口装配项：读面与写回执都可逐次排布。 */
export interface ScriptedRepositoryInput {
  /**
   * 读面队列：第 n 次 load 返回第 n 项，用尽后重复最后一项（partial 缺省的字段
   * 按"可用空库"补齐）。
   */
  readonly reads?: readonly Partial<RulesRead>[];
  /** 写回执队列：第 n 次 save 返回第 n 项，用尽后重复最后一项；空 = 恒 persisted。 */
  readonly outcomes?: readonly RulesWriteOutcome[];
}

/** 手工规则库端口：可断言"读了几次 / 写了几次 / 每次写了什么"。 */
export interface ScriptedRepository {
  readonly repo: RulesRepository;
  /** 已发生的 load 次数。 */
  loads: () => number;
  /** 已发生的 save 次数。 */
  saves: () => number;
  /** 每次 save 收到的数组与 revision。 */
  batches: () => readonly SavedBatch[];
}

/** 排好的读面（partial 补默认值），避免测试重复写 usable: true。 */
function readOf(partial: Partial<RulesRead> | undefined): RulesRead {
  return {
    revision: partial?.revision ?? OPEN_READ.revision,
    cards: partial?.cards ?? [],
    usable: partial?.usable ?? OPEN_READ.usable,
  };
}

/** 取排布队列的第 cursor 项；排布为空（长度 0）时返回 undefined，交调用方用默认值。
 *  越过末尾则钉在最后一项上——"排布用完就沿用最后一次"，不必每条测试都摆够次数。 */
function pick<Item>(queue: readonly Item[], cursor: number): Item | undefined {
  const taken = queue.length === 0 ? undefined : queue[Math.min(cursor, queue.length - 1)];
  return taken;
}

/**
 * 建手工端口（不经 provider）：用于"读不懂""写不进"这类端口级回执与调用记账。
 */
export function scriptedRulesRepository(input: ScriptedRepositoryInput = {}): ScriptedRepository {
  const reads = input.reads ?? [];
  const outcomes = input.outcomes ?? [];
  const writes: SavedBatch[] = [];
  let loadCount = 0;
  return {
    repo: {
      load(): RulesRead {
        const taken = pick(reads, loadCount);
        loadCount += 1;
        return readOf(taken);
      },
      async save(cards: readonly RuleCard[], revision: number): Promise<RulesWriteOutcome> {
        writes.push({ cards: [...cards], revision });
        return pick(outcomes, writes.length - 1) ?? "persisted";
      },
    },
    loads: () => loadCount,
    saves: () => writes.length,
    batches: () => writes,
  };
}

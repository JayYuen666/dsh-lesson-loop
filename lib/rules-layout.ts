// rules-layout：规则库在**设置文档里的坐标**——命名空间名、`rules` 字段名，以及把解析值
// 折成规则卡数组的那一步投影。
//
// 为什么从 lib/rules-namespace.ts 拆出来：坐标与投影是"库住在哪儿、读回来长什么样"，
// 端口实现是"怎么读（describe 取 value/user/revision）、怎么写（update 带 revision 的 CAS）"。
// 三枚坐标在 rules-namespace.ts 内部全都在用（load 拿它读卡、save 拿它写字段、describe 拿它
// 挑本条目那一行），export 面却只有测试与假件在取 ⇒ `fallow --production` 判成「只被测试
// 养着的导出」。拆出来之后端口与端口实现各自只依赖这份坐标，定义仍只有一份。
//
// 段名与本插件条目 id 同源（lib/prompt.ts 的 PLUGIN_NAME），防"卡片绑的段 / 端点前缀 /
// 这里读的段"三处字面量漂移。

import { normalizeRuleCardRow, unknownArray } from "./lesson-store.ts";
import type { RuleCard, RuleEvidence } from "./lesson-store.ts";
import { PLUGIN_NAME } from "./prompt.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/**
 * 规则库存身的设置命名空间 = 本包 profile **条目 id**（`lesson-loop`，见 cordis.patch.yml
 * 的裸 `- id:`）。0.2.1-alpha.2 的注册是隐式的：宿主按条目导出的 `Config` 反推命名空间与可编辑
 * 字段，插件侧不再登记任何段。与 lib/prompt.ts 的 PLUGIN_NAME 同源，防"卡片绑的段 /
 * 端点前缀 / 这里读的段"三处字面量漂移。
 * `satisfies` 把"段名必须是 `lesson-loop` 这个字面量"钉进编译期：`typeof PLUGIN_NAME`
 * 是随 PLUGIN_NAME 推导的，PLUGIN_NAME 若被标注成 `string`，typeof 防护会跟着放宽、
 * 段名静默散成宽类型；satisfies 直接对字面量判可赋值性，宽化当场编译不过。
 */
export const SETTINGS_NAMESPACE = PLUGIN_NAME satisfies "lesson-loop";

/** 规则数组在 `Config` 里的字段名（读写 `describe()` 的 value/user 都以它为键）。 */
export const RULES_FIELD = "rules";

/** 解析后的命名空间值 → 规则卡数组的投影：cards 是逐行归一的结果（非数组一律空库），
 *  dropped 是缺 id 被丢弃的行数——丢弃本身不留痕，谁消费这个投影谁负责上报（见
 *  rules-namespace 的 load），否则 save 用本次读出的卡整片覆盖 `rules` 数组时，一条
 *  手工改坏的存量记录会被永久删除而无人知晓。
 *  行数不够用：`droppedRows` 交出**原样**那几行，让写侧能把它们原封不动写回去。
 *  缺 id 的判据来自 normalizeRuleCardRow 这个会随版本演进的归一器——收紧任何必填字段
 *  都会让升级前的旧卡"看起来缺 id"，只报数不复原等于让升级本身抹掉用户的规则库。
 *  corrupted 把"rules 键在但不是数组"
 *  （value 根本不是记录时同样算）与"合法的空库"在类型面上分开：直接把投影交给
 *  save 的调用方，不能把读不懂当成空库整片写回。 */
export interface CardsProjection {
  readonly cards: RuleCard[];
  readonly dropped: number;
  /** 未能归一的那几行原文（与 `dropped` 等长，顺序同文件）。写侧原样带回去，
   *  否则整片覆盖会把它们从用户存量里删掉。 */
  readonly droppedRows: readonly unknown[];
  /** true = rules 键存在但形状读不懂；空库（键缺席/空数组）为 false。 */
  readonly corrupted: boolean;
}

/** 解析后的命名空间值 → 规则卡投影。 */
export function cardsOfValue(value: unknown): CardsProjection {
  const out: RuleCard[] = [];
  const droppedRows: unknown[] = [];
  const raw = isRecord(value) ? fieldOf(value, RULES_FIELD) : undefined;
  const corrupted = raw !== undefined && !Array.isArray(raw);
  for (const row of unknownArray(raw)) {
    const card = normalizeRuleCardRow(row);
    if (card === null) {
      droppedRows.push(row);
    } else {
      out.push(card);
    }
  }
  return { cards: out, dropped: droppedRows.length, droppedRows, corrupted };
}

/** 单条证据 detail 的字符上限（按码点计，见 truncateByCodePoints）。 */
export const MAX_EVIDENCE_DETAIL_CHARS = 400;
/** 每规则保留的证据条数上限（只留最近这几条）。 */
export const MAX_EVIDENCE_ENTRIES = 5;

/** 按码点截断：detail 可能含代理对（emoji 等），按 UTF-16 码元切会把截断点落在
 *  代理对中间，落盘成孤立代理项（非法 Unicode，读回即显示为替换符）。
 *  for..of 按码点迭代（每格 1-2 码元），上限按码点数计。 */
function truncateByCodePoints(text: string, max: number): string {
  let end = 0;
  let counted = 0;
  for (const char of text) {
    if (counted >= max) {
      break;
    }
    end += char.length;
    counted += 1;
  }
  return text.slice(0, end);
}

/**
 * 持久化前的证据收敛：detail 截断 + 只留最近 N 条。
 *
 * 为什么在写这一侧：规则库整份落在 profile 的 patch 文档里，`evidence` 是其中唯一会无界
 * 增长的部分（实测：长 patch 里绝大部分是 gate 失败与 lint 的逐字转储）。读侧
 * 照旧全量解析、不做二次改写——收敛只发生在落盘那一刻。
 * @param cards 本次要写的规则卡
 * @returns 证据已收敛的新数组（不改入参）
 */
export function capEvidence(cards: readonly RuleCard[]): RuleCard[] {
  const out: RuleCard[] = [];
  for (const card of cards) {
    // "最近 N 条"以 ts 为准：写入侧按上报方的 ts 追加（时钟回拨、乱序上报），
    // mergeFragment 又会把另一张卡（往往更旧）的证据整段并到尾部——数组不保证有序，
    // 直接取尾部可能留下的恰是最旧的几条。排序只作用在副本上，不改入参。
    const kept = [...card.evidence]
      .toSorted((left, right) => left.ts - right.ts)
      .slice(-MAX_EVIDENCE_ENTRIES);
    const evidence: RuleEvidence[] = [];
    for (const row of kept) {
      const cappedText = truncateByCodePoints(row.detail, MAX_EVIDENCE_DETAIL_CHARS);
      const cappedRow: RuleEvidence = {
        ts: row.ts,
        source: row.source,
        // 截没截以截断结果为准，不用两种长度口径各判一次：判据按 UTF-16 码元、
        // 截断按码点，含代理对的文本会出现"没截断却补了省略号"的假截断。
        detail: cappedText === row.detail ? row.detail : `${cappedText}…`,
      };
      if (row.signature !== undefined) {
        cappedRow.signature = row.signature;
      }
      evidence.push(cappedRow);
    }
    // 卡本身：新对象（不改入参），其余字段原样。
    out.push({ ...card, evidence });
  }
  return out;
}

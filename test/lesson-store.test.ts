// lesson-store 单元测试：沉淀/归并/人工升格/度量/衰减 全领域规则 + 存量漂移容错
// + 规则库端口（RulesRepository）的跨进程纪律。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LessonStore,
  PERSIST_FAILED,
  deriveProject,
  isKnownLessonSource,
  normalizeRuleCardRow,
} from "../lib/lesson-store.ts";
import type { RuleCard, RulesRepository } from "../lib/lesson-store.ts";
// 键算法 / 正文起草 / 衰减裁决 / 事件流水落盘四层已从领域核心分家（lib/rule-signature.ts、
// lib/statement-draft.ts、lib/decay-policy.ts、lib/lesson-jsonl.ts）：用例打的就是这四层自己
// 的边界，不再绕道 lesson-store 的转发出口。
import {
  CATEGORY_SIGNATURES,
  looksLikePathSignature,
  normalizeSignature,
  ruleKey,
  stableSignatureFor,
} from "../lib/rule-signature.ts";
import { draftStatement } from "../lib/statement-draft.ts";
import { DEFAULT_DECAY, decayVerdict } from "../lib/decay-policy.ts";
import type { DecayPolicy } from "../lib/decay-policy.ts";
import { appendJsonl, readJsonl } from "../lib/lesson-jsonl.ts";
import { trimJsonl } from "../lib/jsonl-fuse.ts";
// 本包不再有本地 `describeError`：catch 值转日志文本走 shared 的 errorText。
// 这里保留两条断言（逐字搬自被删的那份）不是重复劳动，而是**消费方针**：shared 的
// errors 子路径若改名/掉出 dependencies，本包 12 个 catch 站点会在运行期才炸。
import { errorText } from "@jayyuen666/dsh-plugin-shared/lib/errors";
import { SETTINGS_NAMESPACE } from "../lib/rules-layout.ts";
import { createRulesRepository } from "../lib/rules-namespace.ts";
import type { SettingsCasSurface } from "../lib/rules-namespace.ts";
import { MESSAGES, fill } from "../lib/messages.ts";
import {
  attachRulesRepository,
  makeRulesFacet,
  makeSettingsProvider,
  scriptedRulesRepository,
} from "./rules-fake.ts";
import type { RulesFacet } from "./rules-fake.ts";

// 重复出现的 fixture 值在此单点定义，避免同一字面量散落各处（改一处即全库生效）。
const PROJECT_KEY_FIXTURE = "p-1234abcd";
const PROJECT_KEY_WUKIL = "wukil-a58d36fe";
const PROJECT_KEY_DSH = ".dsh-ebd8b0cc";
const CANON_CWD = "/repo/proj";
const LEDGER_FILE_NAME = "lessons.jsonl";

const CATEGORY_FACTGATE_DENY = "factgate-deny";
const CATEGORY_GATE_FAILURE = "gate-failure";
const CATEGORY_SECRET_PATH = "secret-path";
const CATEGORY_FEEDBACK_DIGEST = "feedback-digest";
const CATEGORY_TRANSIENT_FAILURE = "transient-failure";
const SOURCE_DANGER_GUARD = "danger-guard";
const SOURCE_LESSONS_DIGEST = "lessons-digest";

const SIGNATURE_PATH_A = "/repo/src/a.ts";
const SIGNATURE_PATH_B = "/repo/src/b.ts";
const SIGNATURE_PATH_D = "/repo/src/d.ts";
const SIGNATURE_PATH_Z = "/repo/src/z.ts";
const SIGNATURE_PATH_OTHER = "/repo/src/other.ts";
const SIGNATURE_SECRET_PATH = "/repo/.env";
const SIGNATURE_SECRET_PATH_PROD = "/repo/server/.env.prod";
const MESSY_GATE_SIGNATURE = "  pnpm   check ";
const SIGNATURE_GATE_COMMAND = "pnpm check";
const STABLE_SIG_FACTGATE = "edit-before-factgate";
const STABLE_SIG_FACTGATE_REJECTED = "edit-before-factgate:rejected";
const STABLE_SIG_SECRET_PATH = "edit-before-secret-path";

/** commit 的 CAS 重放上限（= lib/lesson-store.ts 里那枚常量的字面值）。留字面量、不引常量：
 *  这条用例钉的是"首次写 + 上限内几次重放"这个**数**，引常量就成了自证——上限被改动时
 *  该先红的是用例，而不是让用例跟着常量一起漂。 */
const CAS_RETRY_LIMIT = 3;

let scratch: string;
/** 本测试的规则库面（旧写法是每个测试一个临时 rules.json）。 */
let facet: RulesFacet;

function makeStore(overrides: Record<string, unknown> = {}, nowSeq: number[] = []): LessonStore {
  let i = 0;
  const now = (): number => {
    if (nowSeq.length === 0) {
      return 1_700_000_000_000;
    }
    const index = Math.min(i, nowSeq.length - 1);
    i += 1;
    return nowSeq[index]!;
  };
  return new LessonStore({
    lessonsFile: path.join(scratch, LEDGER_FILE_NAME),
    rules: facet.repo,
    // 默认喂 zh 表：本文件既有断言全部钉住起草模板的中文原文（换语言只影响新起草的卡）。
    messages: () => MESSAGES.zh,
    ...overrides,
    now,
  });
}

/** 同一份规则库上的另一个进程（旧写法：再 new 一个指向同一路径的 store）。 */
function otherProcess(
  on: RulesRepository,
  lessonsFile = path.join(scratch, LEDGER_FILE_NAME),
): LessonStore {
  return new LessonStore({
    lessonsFile,
    rules: on,
    messages: () => MESSAGES.zh,
    now: () => 1_700_000_000_000,
  });
}

/**
 * 按 id 取一张卡：`LessonStore.ruleById` 这个成员已删——生产侧从不调它（端点与服务面都取
 * `rules()` 全量投影，人工动作在 commit 的工作数组上自己按 id 找），留着就成了一枚
 * "只被测试养着"的读面。这里的读法与旧成员逐字相同（同一条 `rules()` 读面、同一次 find），
 * 用例钉的仍是卡片落库后的状态，而不是新行为。
 */
function ruleById(store: LessonStore, id: string): RuleCard | undefined {
  return store.rules().find((row) => row.id === id);
}

/**
 * 按序把同一笔上报动作重复 times 次（step 拿到 0..times-1 的下标，供需要换签名的用例用）。
 *
 * 为什么必须串行、不能 Promise.all：一次 report() = 往 lessons.jsonl 追加一行（保险丝按
 * 「此刻累计字节」裁剪）+ 规则库一次 commit（写前重读、带 revision 的整片 CAS 覆写）。
 * occurrences / violation / recurrences 这些计数和 revision 都由上一笔推进，并发发起等于
 * 让 times 笔整片覆写互相撞 CAS、烧掉重放额度，断言退化成竞态。
 *
 * 为什么写成递归而不是 for + await：循环体内的 await 会被 no-await-in-loop 判成「这里该
 * 并发」，而这里恰恰并发不了——与本包 lib/lesson-store.ts 的 commit/attempt、
 * plugins/session-rescue/test/host.test.ts 的 fireSequence 同一写法。
 */
async function reportTimes(
  times: number,
  step: (index: number) => Promise<unknown>,
  index = 0,
): Promise<void> {
  if (index === times) {
    return;
  }
  await step(index);
  return reportTimes(times, step, index + 1);
}

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: SOURCE_DANGER_GUARD,
  category: CATEGORY_FACTGATE_DENY,
  project: PROJECT_KEY_FIXTURE,
  signature: SIGNATURE_PATH_A,
  detail: "must read first",
  ...over,
});

/**
 * 表外类别（CATEGORY_SIGNATURES 未登记）的教训：签名原样进键，一条签名一张卡。
 * 写入侧折叠（Part 1）之后，需要"互不相通的几张卡"时用这个类别，而不是给
 * factgate-deny 造不同路径——那样只会得到同一张卡。
 */
const rawRec = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  rec({ category: CATEGORY_GATE_FAILURE, detail: "gate failed", ...over });

/**
 * 存量卡行（磁盘样本）：Part 1 之后 report() 不再产路径型碎片卡，所以"存量碎片
 * 迁移"只能由存量文件驱动——这也更贴近真实场景（迁移面对的是旧版本写下的库）。
 */
const diskRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "rule-disk",
  project: PROJECT_KEY_FIXTURE,
  category: CATEGORY_FACTGATE_DENY,
  signature: "/repo/src/disk.ts",
  statement: "存量碎片正文",
  status: "candidate",
  createdAt: 1,
  updatedAt: 1,
  occurrences: 1,
  sources: [SOURCE_DANGER_GUARD],
  violation: 0,
  suppressed: 0,
  recurrences: 0,
  evidence: [{ ts: 1, source: SOURCE_DANGER_GUARD, detail: "存量证据" }],
  origin: "threshold",
  ...over,
});

/** 一条证据（磁盘样本内嵌用；字段与 RuleEvidence 同形）。 */
const ev = (detail: string): Record<string, unknown> => ({
  ts: 1,
  source: SOURCE_DANGER_GUARD,
  detail,
});

/** 用存量行重装本测试的规则库（旧写法：把 JSON 数组写进 rules.json）。 */
function seedRules(rows: readonly unknown[]): RulesFacet {
  facet = makeRulesFacet(rows);
  return facet;
}

/** 把存量行装进规则库，返回读回该库的 store。 */
function seedStore(rows: readonly unknown[]): LessonStore {
  seedRules(rows);
  return makeStore();
}

/**
 * 让规则库写不进去：provider 的 update 连续被拒（端口回执 rejected）。
 * 旧实现靠"把 rulesFile 的父路径造成普通文件"制造 ENOTDIR；新边界下失败发生在
 * 端口回执上——路径形态不再是行为面，回执才是。
 * 独立于上面那套（会改写模块级 facet 的）seedRules：它造的是另一份库。
 */
const stuckFacet = (rows: readonly unknown[] = [], times = 99): RulesFacet => {
  const seeded = makeRulesFacet(rows);
  seeded.provider.failWrites(times);
  return seeded;
};

/** 手工 CAS 面（不经 provider）：describe() 的返回形状由参数排布，顺带记 update 次数。 */
function surface(descriptor: () => readonly unknown[]): {
  cas: SettingsCasSurface;
  updates: () => number;
} {
  let count = 0;
  return {
    cas: {
      describe: descriptor,
      update: async (): Promise<void> => {
        count += 1;
      },
    },
    updates: () => count,
  };
}

/** 磁盘上的 armed 碎片行（"归并继承 armed 度量"一节用；字段全给足，只覆盖差异项）。 */
const armedFragmentRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "f-armed",
  project: PROJECT_KEY_FIXTURE,
  category: CATEGORY_FACTGATE_DENY,
  signature: "/repo/src/x.ts",
  statement: "armed 碎片正文",
  status: "armed",
  createdAt: 10,
  updatedAt: 10,
  occurrences: 5,
  sources: [SOURCE_DANGER_GUARD],
  violation: 2,
  suppressed: 3,
  recurrences: 0,
  evidence: [],
  origin: "threshold",
  ...over,
});

/** 磁盘上的稳定候选行：归并时作主卡承接碎片的度量与正文。 */
const stableCandidateRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "s-stable",
  project: PROJECT_KEY_FIXTURE,
  category: CATEGORY_FACTGATE_DENY,
  signature: STABLE_SIG_FACTGATE,
  statement: "已存在的稳定候选卡",
  status: "candidate",
  createdAt: 1,
  updatedAt: 1,
  occurrences: 1,
  sources: [],
  violation: 0,
  suppressed: 0,
  recurrences: 0,
  evidence: [],
  origin: "threshold",
  ...over,
});

/** 一张真规则卡（走生产归一器，避免手搓字段漏项）：端口队列与"另一进程"用。 */
const cardOf = (over: Record<string, unknown> = {}): RuleCard =>
  normalizeRuleCardRow(diskRow({ category: CATEGORY_GATE_FAILURE, ...over }))!;

/** 规则库里此刻真存着的卡签名（排序后比对，写入顺序不进断言）。 */
const persistedSigsOf = (on: RulesFacet): string[] =>
  on
    .persisted()
    .map((row) => row.signature)
    .toSorted();

/** 一组卡行的签名（排序后比对）：跨进程一节断言"库里现在有哪几张"。 */
const signaturesOf = (cards: readonly RuleCard[]): string[] =>
  cards.map((row) => row.signature).toSorted();

/** 本条用例的台账文件路径（跟着 `scratch` 走，故留在 describe 之外的模块作用域）。 */
const lessonsFile = (): string => path.join(scratch, LEDGER_FILE_NAME);
/** 与 `makeStore()` 同义，只是读起来点明"每条用例一份新库"。 */
const freshStore = (): LessonStore => makeStore();

/** 表外类别（gate-failure）的存量卡：一条签名一张卡，状态由参数决定。 */
const stuckRow = (
  id: string,
  status: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> =>
  diskRow({ id, category: CATEGORY_GATE_FAILURE, signature: id, status, ...over });

/** 收 console.error 的一次性探针（坏存量点名的断言用；不捕获外层作用域，故放在 describe 之外）。 */
function captureErrors(): { text: () => string; count: () => number; restore: () => void } {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    text: () => calls.map((args) => args.map(String).join(" ")).join("\n"),
    count: () => calls.length,
    restore: () => {
      console.error = original;
    },
  };
}

describe("lesson-store：台账、规则库与度量", () => {
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "lesson-store-"));
    facet = makeRulesFacet();
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("deriveProject", () => {
    it("与 gateway-feedback deriveAgentId 同语义", async () => {
      // 结构断言：尾目录名-8位hex（与 gateway-feedback.ts deriveAgentId 的分桶规则一致，
      // 两者都只是 shared/lib/project-key.ts 的别名）
      assert.match(deriveProject("/Users/x/dev/wukil"), /^wukil-[0-9a-f]{8}$/u);
      assert.equal(deriveProject(undefined), "default");
      assert.equal(deriveProject("/"), "default");
      // 兼容锚点：绝对且已规范的路径，键与旧"纯字符串归一"逐字节相同（存量桶不迁移）
      assert.equal(deriveProject("/Users/dev/proj"), "proj-75ff31d9");
    });
  });

  describe("normalizeSignature / ruleKey", () => {
    it("签名空白归一、键三段拼接", async () => {
      assert.equal(normalizeSignature(MESSY_GATE_SIGNATURE), SIGNATURE_GATE_COMMAND);
      assert.equal(ruleKey("p", "c", " s  "), "p\u0000c\u0000s");
    });
  });

  /**
   * draftStatement 的十一条模板场景（与 lib/messages.ts 的 statement* 段一一对应）。
   * `embeds` = 该模板把 signature 嵌进正文；类别级稳定签名的两条与 max-tokens /
   * unfinished-turn 一样是通用正文，刻意不嵌（碎片化修复的既有语义）。
   */
  const DRAFT_CASES: readonly {
    readonly category: string;
    readonly signature: string;
    readonly embeds: boolean;
  }[] = [
    { category: CATEGORY_FACTGATE_DENY, signature: STABLE_SIG_FACTGATE, embeds: false },
    { category: CATEGORY_FACTGATE_DENY, signature: STABLE_SIG_FACTGATE_REJECTED, embeds: true },
    { category: CATEGORY_FACTGATE_DENY, signature: SIGNATURE_PATH_A, embeds: true },
    { category: "dangerous-bash", signature: "rm -rf ./cache", embeds: true },
    { category: CATEGORY_SECRET_PATH, signature: STABLE_SIG_SECRET_PATH, embeds: false },
    { category: CATEGORY_SECRET_PATH, signature: SIGNATURE_SECRET_PATH, embeds: true },
    { category: CATEGORY_GATE_FAILURE, signature: SIGNATURE_GATE_COMMAND, embeds: true },
    { category: CATEGORY_TRANSIENT_FAILURE, signature: "cavoti code", embeds: true },
    { category: "max-tokens", signature: "sig", embeds: false },
    { category: "unfinished-turn", signature: "sig", embeds: false },
    { category: "unknown-cat", signature: "some other thing", embeds: true },
  ];

  describe("draftStatement", () => {
    it("已知分类给出可执行模板，未知分类兜底", async () => {
      assert.match(draftStatement(CATEGORY_FACTGATE_DENY, "/a.ts", MESSAGES.zh), /read/u);
      assert.match(
        draftStatement(CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE, MESSAGES.zh),
        /编辑文件之前/u,
      );
      assert.match(
        draftStatement(CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE_REJECTED, MESSAGES.zh),
        /归档汇总/u,
      );
      assert.match(
        draftStatement(CATEGORY_GATE_FAILURE, SIGNATURE_GATE_COMMAND, MESSAGES.zh),
        /pnpm check/u,
      );
      assert.match(draftStatement("unknown-cat", "sig", MESSAGES.zh), /sig/u);
    });

    it("locale=en：起草出的十一条正文全是英文（不含汉字），且不留占位符", async () => {
      const statementKeys = Object.keys(MESSAGES.en).filter((key) => key.startsWith("statement"));
      assert.equal(statementKeys.length, 11, "字典 statement* 段与模板场景表同源");
      assert.equal(DRAFT_CASES.length, statementKeys.length);
      for (const scenario of DRAFT_CASES) {
        const drafted = draftStatement(scenario.category, scenario.signature, MESSAGES.en);
        assert.ok(drafted.length > 0, `${scenario.category} 起草出了空正文`);
        assert.doesNotMatch(
          drafted,
          /\p{Script=Han}/u,
          `${scenario.category} 的 en 正文混入汉字：${drafted}`,
        );
        assert.ok(
          !drafted.includes("{") && !drafted.includes("}"),
          `${scenario.category} 的 en 正文残留占位符：${drafted}`,
        );
      }
    });

    it("{signature} 在 zh/en 两语下都落位：嵌占位的模板带原文，通用正文不嵌", async () => {
      for (const scenario of DRAFT_CASES) {
        for (const messages of [MESSAGES.zh, MESSAGES.en]) {
          const drafted = draftStatement(scenario.category, scenario.signature, messages);
          if (scenario.embeds) {
            assert.ok(
              drafted.includes(scenario.signature),
              `${scenario.category} 的正文没嵌进 signature：${drafted}`,
            );
          } else {
            assert.ok(
              !drafted.includes(scenario.signature),
              `${scenario.category} 的通用正文不该带 signature：${drafted}`,
            );
          }
        }
      }
    });

    it("feedback-digest 的正文是模型产出的 signature 本身：两语下都原样透传，不进字典", async () => {
      assert.equal(draftStatement(CATEGORY_FEEDBACK_DIGEST, "模型原话", MESSAGES.zh), "模型原话");
      assert.equal(draftStatement(CATEGORY_FEEDBACK_DIGEST, "模型原话", MESSAGES.en), "模型原话");
    });

    it("report 开新卡吃 store 的消息表：en 表下新起草的候选卡正文是英文", async () => {
      const zhStore = makeStore();
      const zhDraft = await zhStore.report(rawRec({ signature: SIGNATURE_GATE_COMMAND }) as never);
      assert.equal(
        zhDraft.candidate?.statement,
        fill(MESSAGES.zh.statementGateFailure, { signature: SIGNATURE_GATE_COMMAND }),
      );

      // 另起一份规则库与流水：同库共享会让这条上报命中上面那张 zh 卡（走 accumulate，
      // 不再起草），en 模板就没被测到了。
      const enStore = makeStore({
        rules: makeRulesFacet().repo,
        lessonsFile: path.join(scratch, "lessons-en.jsonl"),
        messages: () => MESSAGES.en,
      });
      const enDraft = await enStore.report(rawRec({ signature: SIGNATURE_GATE_COMMAND }) as never);
      const enStatement = enDraft.candidate?.statement ?? "";
      assert.equal(
        enStatement,
        fill(MESSAGES.en.statementGateFailure, { signature: SIGNATURE_GATE_COMMAND }),
      );
      assert.doesNotMatch(enStatement, /\p{Script=Han}/u);
    });

    it("rejected 汇总卡的容器正文同样随消息表走（en 无汉字，zh 保留原模板原文）", async () => {
      const summarySig = `${CATEGORY_SIGNATURES[CATEGORY_FACTGATE_DENY]}:rejected`;
      const zhStore = seedStore([
        diskRow({ id: "sum-zh", signature: "/repo/src/zh.ts", status: "rejected" }),
      ]);
      await zhStore.migrateFragmentRules();
      assert.equal(
        ruleById(zhStore, "sum-zh")?.statement,
        fill(MESSAGES.zh.statementFactgateRejected, { signature: summarySig }),
      );

      seedRules([diskRow({ id: "sum-en", signature: "/repo/src/en.ts", status: "rejected" })]);
      const enStore = makeStore({ messages: () => MESSAGES.en });
      await enStore.migrateFragmentRules();
      const container = ruleById(enStore, "sum-en")?.statement ?? "";
      assert.equal(
        container,
        fill(MESSAGES.en.statementFactgateRejected, { signature: summarySig }),
      );
      assert.doesNotMatch(container, /\p{Script=Han}/u);
    });

    it("语言切换不动已落库正文：签名已是汇总键的卡在 en 表下不被改写", async () => {
      seedRules([
        diskRow({
          id: "kept",
          signature: STABLE_SIG_FACTGATE_REJECTED,
          statement: "旧版写下的人话",
        }),
      ]);
      const enStore = makeStore({ messages: () => MESSAGES.en });
      await enStore.migrateFragmentRules();
      assert.equal(ruleById(enStore, "kept")?.statement, "旧版写下的人话");
      assert.equal(ruleById(enStore, "kept")?.signature, STABLE_SIG_FACTGATE_REJECTED);
    });
  });

  describe("looksLikePathSignature", () => {
    it("路径/相对路径/带后缀文件名识别为路径，命令/短键不识别", async () => {
      assert.equal(looksLikePathSignature("/Users/x/repo/src/a.ts"), true);
      assert.equal(looksLikePathSignature("admin/src/pages/Tenants/index.tsx"), true);
      assert.equal(looksLikePathSignature(".dsh/plugin/host.ts"), true);
      assert.equal(looksLikePathSignature(SIGNATURE_GATE_COMMAND), false);
      assert.equal(looksLikePathSignature(STABLE_SIG_FACTGATE), false);
    });
  });

  describe("migrateFragmentRules：存量碎片合并", () => {
    it("路径签名候选碎片并入稳定签名卡，occurrences/evidence 累加", async () => {
      // 存量库里的两张路径碎片（旧写入侧按路径分片；现在 report() 已不再产出）
      const store = seedStore([
        diskRow({ id: "f-a", signature: SIGNATURE_PATH_A, evidence: [ev("a 路径证据")] }),
        diskRow({ id: "f-b", signature: SIGNATURE_PATH_B, evidence: [ev("b 路径证据")] }),
      ]);
      assert.equal(store.rules().length, 2);
      const merged = await store.migrateFragmentRules();
      assert.equal(merged, 1);
      const rules = store.rules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.signature, CATEGORY_SIGNATURES[CATEGORY_FACTGATE_DENY]);
      assert.equal(rules[0]?.occurrences, 2);
      assert.equal(rules[0].evidence.length, 2);
      assert.deepEqual(
        rules[0].evidence.map((row) => row.detail),
        ["a 路径证据", "b 路径证据"],
      );
    });

    it("armed 碎片保留人工 statement，其它碎片并入", async () => {
      const store = seedStore([
        diskRow({
          id: "f-c",
          signature: "/repo/src/c.ts",
          status: "armed",
          armedAt: 5,
          statement: "人工改写的通用规则",
        }),
        diskRow({ id: "f-d", signature: SIGNATURE_PATH_D }),
      ]);
      assert.equal(store.rules().length, 2);
      await store.migrateFragmentRules();
      const rules = store.rules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.status, "armed");
      assert.equal(rules[0].statement, "人工改写的通用规则");
      assert.equal(rules[0].occurrences, 2);
    });

    it("单条 rejected 碎片并入 rejected 汇总卡", async () => {
      const store = seedStore([
        diskRow({ id: "f-e", signature: "/repo/src/e.ts", status: "rejected" }),
      ]);
      assert.equal(store.rules().length, 1);
      const merged = await store.migrateFragmentRules();
      // 单张碎片自身成为汇总卡 primary（无并入），签名改为稳定+:rejected。
      assert.equal(merged, 0);
      assert.equal(store.rules().length, 1);
      assert.equal(store.rules()[0]?.signature, STABLE_SIG_FACTGATE_REJECTED);
      assert.equal(store.rules()[0]?.status, "rejected");
    });

    it("多条 rejected 路径碎片并入同一张 :rejected 汇总卡", async () => {
      const store = seedStore([
        diskRow({
          id: "f-f",
          signature: "/repo/src/f.ts",
          status: "rejected",
          evidence: [ev("f")],
        }),
        diskRow({
          id: "f-g",
          signature: "/repo/src/g.ts",
          status: "rejected",
          evidence: [ev("g")],
        }),
      ]);
      assert.equal(store.rules().length, 2);
      const merged = await store.migrateFragmentRules();
      assert.equal(merged, 1);
      const rules = store.rules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.signature, STABLE_SIG_FACTGATE_REJECTED);
      assert.equal(rules[0].status, "rejected");
      assert.equal(rules[0].occurrences, 2);
      assert.equal(rules[0].evidence.length, 2);
    });

    it("非路径签名（如 transient-failure provider）不受影响", async () => {
      const store = makeStore();
      await store.report(
        rec({ category: CATEGORY_TRANSIENT_FAILURE, signature: "cavoti code SERVER" }) as never,
      );
      assert.equal(await store.migrateFragmentRules(), 0);
      assert.equal(store.rules().length, 1);
    });

    it("跨项目碎片各自归并，不混入同一张卡", async () => {
      const store = seedStore([
        diskRow({ id: "f-h", project: PROJECT_KEY_WUKIL, signature: "/wukil/src/a.ts" }),
        diskRow({ id: "f-i", project: PROJECT_KEY_DSH, signature: "/.dsh/plugins/b.ts" }),
      ]);
      assert.equal(store.rules().length, 2);
      const merged = await store.migrateFragmentRules();
      // 各项目只有单张碎片（自己即 primary），无跨项目合并 → 0。
      assert.equal(merged, 0);
      const rules = store.rules();
      assert.equal(rules.length, 2);
      assert.deepEqual(rules.map((rule) => rule.project).toSorted(), [
        PROJECT_KEY_DSH,
        PROJECT_KEY_WUKIL,
      ]);
      assert.ok(rules.every((rule) => rule.signature === STABLE_SIG_FACTGATE));
      assert.ok(rules.every((rule) => rule.occurrences === 1));
    });

    it("同项目多张碎片并入 stable 卡；跨项目卡互不干扰", async () => {
      const store = seedStore([
        diskRow({ id: "f-j", project: PROJECT_KEY_WUKIL, signature: "/wukil/src/a.ts" }),
        diskRow({ id: "f-k", project: PROJECT_KEY_WUKIL, signature: "/wukil/src/b.ts" }),
        diskRow({ id: "f-l", project: PROJECT_KEY_DSH, signature: "/.dsh/plugins/c.ts" }),
      ]);
      assert.equal(store.rules().length, 3);
      const merged = await store.migrateFragmentRules();
      assert.equal(merged, 1);
      const rules = store.rules();
      assert.equal(rules.length, 2);
      const wukil = rules.find((rule) => rule.project === PROJECT_KEY_WUKIL);
      const dsh = rules.find((rule) => rule.project === PROJECT_KEY_DSH);
      assert.ok(wukil?.signature === STABLE_SIG_FACTGATE);
      assert.equal(wukil.occurrences, 2);
      assert.ok(dsh?.signature === STABLE_SIG_FACTGATE);
      assert.equal(dsh.occurrences, 1);
    });

    it("迁移幂等：再跑一次零归并（写入侧也不再产新碎片）", async () => {
      const store = seedStore([
        diskRow({ id: "f-m", signature: "/repo/src/m.ts" }),
        diskRow({ id: "f-n", signature: "/repo/src/n.ts" }),
      ]);
      assert.equal(await store.migrateFragmentRules(), 1);
      assert.equal(await store.migrateFragmentRules(), 0);
      // 新上报直接落在稳定签名上，不重新开碎片
      await store.report(rec({ signature: "/repo/src/new.ts" }) as never);
      assert.equal(store.rules().length, 1);
      assert.equal(await store.migrateFragmentRules(), 0);
      assert.equal(store.rules()[0]?.occurrences, 3);
    });

    it("live 碎片 + 已在位的 :rejected 汇总卡：汇总卡不被动、updatedAt 不被推进", async () => {
      // 汇总卡的签名不是路径型（looksLikePathSignature 不收），于是它压根不进 candidates，
      // rejected 组为空 —— 归并走的是「primary 已在位、既无并入也无需改写」那条出口。
      // 这条出口若被误判成 dirty，会给一张没人改过的卡盖上新的 updatedAt。
      const store = seedStore([
        diskRow({ id: "f-live", signature: "/repo/src/live.ts" }),
        diskRow({
          id: "f-sum",
          signature: STABLE_SIG_FACTGATE_REJECTED,
          status: "rejected",
          updatedAt: 7,
        }),
      ]);
      const before = ruleById(store, "f-sum");
      assert.equal(before?.updatedAt, 7, "样本前提：汇总卡自带 updatedAt");
      assert.equal(await store.migrateFragmentRules(), 0, "没有碎片被并进来");
      const rules = store.rules();
      assert.equal(rules.length, 2, "汇总卡与稳定卡各自独立");
      const summary = rules.find((row) => row.id === "f-sum");
      assert.equal(summary?.updatedAt, 7, "未被改动的汇总卡不许被盖上时间戳");
      assert.equal(summary.signature, STABLE_SIG_FACTGATE_REJECTED);
      assert.equal(rules.find((row) => row.id === "f-live")?.signature, STABLE_SIG_FACTGATE);
    });

    it("rejected 碎片 + 已在位的稳定卡：稳定卡不被动、updatedAt 不被推进", async () => {
      // 该 project 的 live 组为空（唯一碎片是 rejected），但稳定签名卡已在位 →
      // primary 落在它身上，既无并入也无需改写签名。
      const store = seedStore([
        diskRow({
          id: "f-stable",
          signature: STABLE_SIG_FACTGATE,
          status: "armed",
          armedAt: 3,
          updatedAt: 11,
        }),
        diskRow({ id: "f-rej", signature: "/repo/src/rej.ts", status: "rejected" }),
      ]);
      assert.equal(await store.migrateFragmentRules(), 0, "没有碎片被并进稳定卡");
      const rules = store.rules();
      const stable = rules.find((row) => row.id === "f-stable");
      assert.equal(stable?.updatedAt, 11, "未被改动的稳定卡不许被盖上时间戳");
      assert.equal(stable.status, "armed");
      assert.equal(stable.occurrences, 1, "rejected 碎片不并进活卡");
      assert.equal(stable.armedAt, 3, "arm 期锚点保持原样");
      assert.equal(
        rules.find((row) => row.id === "f-rej")?.signature,
        STABLE_SIG_FACTGATE_REJECTED,
        "rejected 碎片自成新汇总卡",
      );
    });
  });

  describe("rejected 复活（recurrences）", () => {
    it("rejected 后同签名再犯累积 recurrences，达阈值转回候选", async () => {
      const store = makeStore({ promoteThreshold: 3, reviveThreshold: 2 });
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "reject");
      assert.equal(ruleById(store, id)?.status, "rejected");
      // 第一次复发：recurrences=1 < 2，仍 rejected
      await store.report(rec() as never);
      assert.equal(ruleById(store, id)?.status, "rejected");
      assert.equal(ruleById(store, id)?.recurrences, 1);
      // 第二次复发：recurrences=2 ≥ 2 → 转回候选，occurrences=2
      await store.report(rec() as never);
      const card = ruleById(store, id);
      assert.equal(card?.status, "candidate");
      assert.equal(card.recurrences, 0);
      assert.equal(card.occurrences, 2);
    });

    it("reject 动作清零 recurrences", async () => {
      const store = makeStore({ reviveThreshold: 3 });
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "reject");
      await store.report(rec() as never);
      assert.equal(ruleById(store, id)?.recurrences, 1);
      await store.ruleAction(id, "reject");
      assert.equal(ruleById(store, id)?.recurrences, 0);
    });

    it("存量卡缺 recurrences 字段按 0 补齐（旧库升级读取）", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "reject");
      // 存量库形态：整片抹掉 recurrences（模拟旧版本写下的库，端口侧热加载）
      facet.setExternally(
        store.rules().map((rule) => {
          const { recurrences, ...rest } = rule;
          void recurrences;
          return rest;
        }),
      );
      const reloaded = otherProcess(facet.repo);
      assert.equal(reloaded.rules()[0]?.recurrences, 0);
    });
  });

  describe("pass 信号驱动 suppressed", () => {
    it("仅被 pass 过的 armed 规则在会话收尾计 suppressed；无关规则不计", async () => {
      const store = makeStore();
      // 两张 armed 规则：a 用类别稳定签名（pass 匹配键），b 用表外类别的自有签名
      const { candidate } = await store.report(rec({ signature: STABLE_SIG_FACTGATE }) as never);
      const { id: a } = candidate!;
      const { candidate: candidateSecond } = await store.report(
        rawRec({ signature: "second-rule-key" }) as never,
      );
      const { id: second } = candidateSecond!;
      await store.ruleAction(a, "arm", "A rule");
      await store.ruleAction(second, "arm", "B rule");
      const passA = store.pass(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE);
      assert.ok(passA?.id === a);
      // 会话只 pass 了 a，收尾只计 a
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([a]), "s1");
      assert.equal(ruleById(store, a)?.suppressed, 1);
      assert.equal(ruleById(store, second)?.suppressed, 0);
    });

    it("pass 但本会话也违规 → 不计 suppressed", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec({ signature: STABLE_SIG_FACTGATE }) as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm", "rule");
      store.pass(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE);
      // armed 命中 → violation
      await store.report(rec({ signature: STABLE_SIG_FACTGATE }) as never);
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set([id]), new Set([id]), "s1");
      assert.equal(ruleById(store, id)?.suppressed, 0);
    });

    it("无 pass 的普通干净会话不再给任何规则灌水 suppressed", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm", "rule");
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set(), "s1");
      assert.equal(ruleById(store, id)?.suppressed, 0);
    });
  });

  describe("report：候选归并与升格门槛", () => {
    it("首报建候选；同键累积 occurrences；达阈值 ready", async () => {
      const store = makeStore({ promoteThreshold: 3 });
      const r1 = await store.report(rec() as never);
      assert.equal(r1.candidate?.occurrences, 1);
      assert.equal(r1.ready, false);
      const r2 = await store.report(rec() as never);
      assert.equal(r2.candidate?.occurrences, 2);
      assert.equal(r2.ready, false);
      const r3 = await store.report(rec() as never);
      assert.equal(r3.ready, true);
      // 登记表内的类别：换目标路径不再另开一张卡（Part 1 的汇聚点）
      const r4 = await store.report(rec({ signature: SIGNATURE_PATH_B }) as never);
      assert.equal(store.rules().length, 1);
      assert.equal(r4.candidate?.occurrences, 4);
      // 表外类别保持"一条签名一张卡"
      await store.report(rawRec({ signature: "/repo/src/c.ts" }) as never);
      await store.report(rawRec({ signature: SIGNATURE_PATH_D }) as never);
      assert.equal(store.rules().length, 3);
    });

    it("教训全量落 JSONL（不截断），detail 原样在盘", async () => {
      const store = makeStore();
      const long = "x".repeat(100_000);
      await store.report(rec({ detail: long }) as never);
      const file = path.join(scratch, LEDGER_FILE_NAME);
      assert.ok(existsSync(file));
      const rows = readJsonl(file);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!["detail"], long);
    });

    it("不同来源归并进同一张候选卡并记录 sources", async () => {
      const store = makeStore();
      await store.report(rec() as never);
      await store.report(rec({ source: SOURCE_LESSONS_DIGEST }) as never);
      assert.equal(store.rules().length, 1);
      assert.deepEqual(store.rules()[0]?.sources, [SOURCE_DANGER_GUARD, SOURCE_LESSONS_DIGEST]);
    });
  });

  describe("人工升格与度量", () => {
    it("arm 后同类教训计 violation；被 pass 的会话计 suppressed", async () => {
      const store = makeStore();
      const r1 = await store.report(rec() as never);
      const { id } = r1.candidate!;
      assert.ok(await store.ruleAction(id, "arm", "先 read 再编辑"));
      const card = ruleById(store, id);
      assert.equal(card?.status, "armed");
      assert.equal(card.statement, "先 read 再编辑");
      // 复发
      const r2 = await store.report(rec() as never);
      assert.equal(r2.violationOf?.violation, 1);
      // 被 pass 的会话（规则场景触发且遵守）
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([id]), "s1");
      assert.equal(ruleById(store, id)?.suppressed, 1);
      // 本会话复发过的规则不计 suppressed
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set([id]), new Set([id]), "s2");
      assert.equal(ruleById(store, id)?.suppressed, 1);
    });

    it("arm 清零历史度量（新生命周期重新计数）", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm");
      await store.report(rec() as never);
      await store.ruleAction(id, "demote");
      await store.ruleAction(id, "arm");
      assert.equal(ruleById(store, id)?.violation, 0);
      assert.equal(ruleById(store, id)?.suppressed, 0);
    });

    it("rejected/archived 状态只补证据不复活、不计度量", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "reject");
      const rejectedReport = await store.report(rec() as never);
      assert.equal(rejectedReport.violationOf, undefined);
      assert.equal(rejectedReport.candidate, undefined);
      assert.equal(ruleById(store, id)?.status, "rejected");
      assert.equal(ruleById(store, id)?.evidence.length, 2);
    });

    it("arm 缺 statement 保留模板正文", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm");
      assert.match(ruleById(store, id)!.statement, /read/u);
    });
  });

  describe("衰减", () => {
    it("复发率高且样本足 → demote", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm");
      // 1 被遵守 + 5 复发 = 6 样本，率 5/6 ≥ 0.5 且 violation 5 ≥ 3
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([id]), "s");
      await reportTimes(5, () => store.report(rec() as never));
      assert.equal(ruleById(store, id)?.status, "demoted");
    });

    it("样本不足不 demote", async () => {
      const store = makeStore({ demoteMinSamples: 10 });
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm");
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([id]), "s");
      await reportTimes(5, () => store.report(rec() as never));
      assert.equal(ruleById(store, id)?.status, "armed");
    });

    it("armed 后长期零信号 → 判不可判定（保留 armed，不再自动归档）", async () => {
      const t0 = 1_700_000_000_000;
      const store = makeStore({ decayDays: 30 }, [t0, t0, t0 + 31 * 86_400_000]);
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm");
      const out = await store.runDecay();
      // 既不降级也不归档：只报告"不可判定"，状态仍 armed，等人停用/归档。
      assert.deepEqual(out, { demoted: 0, undeterminable: 1 });
      assert.equal(ruleById(store, id)?.status, "armed");
      assert.equal(store.isUndeterminable(ruleById(store, id)!), true);
    });

    it("decayVerdict 纯函数边界", async () => {
      const t0 = 1_700_000_000_000;
      const base = {
        id: "r",
        project: "p",
        category: "c",
        signature: "s",
        statement: "t",
        status: "armed" as const,
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
        origin: "threshold" as const,
      };
      // armed 满一年、只有一次违规、零干净命中：复发率无分母（分子就是自己的分母），
      // 无从判定规则好坏 → 报不可判定而非降级，也而非静默 keep。
      assert.equal(
        decayVerdict(
          { ...base, violation: 1, lastViolationAt: t0 },
          DEFAULT_DECAY,
          t0 + 365 * 86_400_000,
        ),
        "undeterminable",
      );
      assert.equal(decayVerdict({ ...base }, DEFAULT_DECAY, t0 + 29 * 86_400_000), "keep");
      assert.equal(
        decayVerdict({ ...base, status: "candidate" }, DEFAULT_DECAY, t0 + 365 * 86_400_000),
        "keep",
      );
    });
  });

  describe("addCandidate（/lessons-digest 入口）", () => {
    it("新建候选；同键候选累积", async () => {
      const store = makeStore();
      const c1 = await store.addCandidate({
        project: "p",
        category: CATEGORY_FEEDBACK_DIGEST,
        signature: "sig",
        statement: "s1",
        detail: "d",
      });
      const c2 = await store.addCandidate({
        project: "p",
        category: CATEGORY_FEEDBACK_DIGEST,
        signature: "sig",
        statement: "s2",
        detail: "d",
      });
      assert.equal(c1.id, c2.id);
      assert.equal(c2.occurrences, 2);
      assert.equal(c2.statement, "s1");
    });

    it("origin 标记 lessons-digest", async () => {
      const store = makeStore();
      const candidate = await store.addCandidate({
        project: "p",
        category: "c",
        signature: "s",
        statement: "st",
        detail: "d",
      });
      assert.equal(candidate.origin, SOURCE_LESSONS_DIGEST);
    });
  });

  describe("持久化", () => {
    it("规则库跨实例重载（settings 命名空间 CAS）", async () => {
      const store1 = makeStore();
      const { candidate } = await store1.report(rec() as never);
      const { id } = candidate!;
      await store1.ruleAction(id, "arm", "v2");
      const store2 = otherProcess(facet.repo);
      assert.equal(ruleById(store2, id)?.status, "armed");
      assert.equal(ruleById(store2, id)?.statement, "v2");
    });

    it("段落存量不合 schema → 端口退不可用，读空且不抛", async () => {
      // 旧实现面对的是"半个 JSON 文件"，新边界下面对的是"解析不过的存量段"：
      // 注册被打回 → 读空 + 拒写（详见 describe("规则库端口 createRulesRepository")）
      const provider = makeSettingsProvider({ [SETTINGS_NAMESPACE]: { rules: "不是数组" } });
      const store = otherProcess(attachRulesRepository(provider));
      assert.equal(store.rules().length, 0);
      const receipt = await store.report(rawRec({ signature: "cmd-x" }) as never);
      assert.equal(receipt.ok, false);
      assert.equal(provider.writesOf(SETTINGS_NAMESPACE), 0);
    });

    it("maxLessonsBytes 保险丝生效；0 = 不设上限", async () => {
      const capped = makeStore({ maxLessonsBytes: 300 });
      await reportTimes(20, (i) =>
        capped.report(rec({ detail: "d".repeat(80), signature: `s${i}` }) as never),
      );
      const size = readFileSync(path.join(scratch, LEDGER_FILE_NAME), "utf8").length;
      assert.ok(size <= 300 + 200, `size=${size}`);
      // 0 = 不限：20 条全在
      const unlimited = makeStore({ maxLessonsBytes: 0 });
      await reportTimes(20, (i) =>
        unlimited.report(rec({ detail: "d".repeat(80), signature: `s${i}` }) as never),
      );
      assert.equal(readJsonl(path.join(scratch, LEDGER_FILE_NAME)).length >= 20, true);
    });
  });

  describe("规则库端口 createRulesRepository", () => {
    it("surface 缺位（null，注册被打回 / 宿主无 CAS 面）→ 读不可用、写一律 rejected", async () => {
      const repo = createRulesRepository(null);
      const read = repo.load();
      assert.equal(read.usable, false, "没有 CAS 面就不许背书任何库内容");
      assert.deepEqual(read.cards, []);
      assert.equal(read.revision, 0);
      assert.equal(await repo.save([cardOf({ id: "x", signature: "s" })], 0), "rejected");
      // 接上 store：任何一次改动都退成 persist-failed，且回读写也不被调用
      const store = otherProcess(repo);
      const receipt = await store.report(rawRec({ signature: "cmd-none" }) as never);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.reason, PERSIST_FAILED);
      assert.equal(store.rules().length, 0);
    });

    it("describe() 里没有本命名空间（注册被回收）→ 按不可用读，绝不退成空库再写回", async () => {
      const boxed = surface(() => [
        { ns: "some-other-namespace", value: { rules: [] }, revision: 3 },
      ]);
      const repo = createRulesRepository(boxed.cas);
      const read = repo.load();
      assert.equal(read.usable, false, "看不见这一段 ≠ 这段是空的");
      assert.deepEqual(read.cards, []);
      const store = otherProcess(repo);
      const receipt = await store.report(rawRec({ signature: "cmd-gone" }) as never);
      assert.equal(receipt.ok, false);
      assert.equal(boxed.updates(), 0, "不可用读不背书任何一次写");
    });

    it("descriptor 的 value 非对象 / revision 非数字 → 空库 + revision 退 0", () => {
      const boxed = surface(() => [
        { ns: SETTINGS_NAMESPACE, value: "用户手改坏的存量段", revision: "3" },
      ]);
      const read = createRulesRepository(boxed.cas).load();
      assert.equal(read.usable, true, "读得动，只是内容不合形状");
      assert.deepEqual(read.cards, []);
      assert.equal(read.revision, 0, "revision 不是数字时退 0，不拿脏值当 CAS 条件");
    });

    it("describe() 抛错 → rules read failed 日志 + 不可用读（不外抛）", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const boxed = surface(() => {
        throw new Error("宿主读不动");
      });
      assert.equal(createRulesRepository(boxed.cas).load().usable, false);
      assert.match(String(error.mock.calls[0]?.[0]), /rules read failed: 宿主读不动/u);
      error.mockRestore();
    });
  });

  describe("isKnownLessonSource", () => {
    it("内置五个来源为 true，自报的第三方名与畸形值为 false", () => {
      // 名单在测试里写死一份：改动内置来源必须同时改这里，不给"顺手加一个"留空间
      for (const name of [
        SOURCE_DANGER_GUARD,
        "quality-gate",
        "session-rescue",
        SOURCE_LESSONS_DIGEST,
        "manual",
      ]) {
        assert.equal(isKnownLessonSource(name), true, `${name} 是宿主自带生产者`);
      }
      assert.equal(isKnownLessonSource("gateway-feedback"), false, "表外来源不算内置");
      // 非字符串一律 false（判定先得过 typeof 这一关）
      assert.equal(isKnownLessonSource(undefined), false);
      assert.equal(isKnownLessonSource(null), false);
      assert.equal(isKnownLessonSource(42), false);
      assert.equal(isKnownLessonSource(["manual"]), false);
    });
  });

  describe("recentLessons / lessonsCount", () => {
    it("project 过滤 + limit 语义（≤0 全量）", async () => {
      const store = makeStore();
      await store.report(rec() as never);
      await store.report(rec({ project: "other" }) as never);
      await store.report(rec() as never);
      assert.equal(store.lessonsCount(), 3);
      assert.equal(store.recentLessons(PROJECT_KEY_FIXTURE).length, 2);
      assert.equal(store.recentLessons(PROJECT_KEY_FIXTURE, 1).length, 1);
    });
  });

  describe("configure", () => {
    it("运行时阈值同步生效", async () => {
      const store = makeStore({ promoteThreshold: 5 });
      const { candidate } = await store.report(rec() as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm");
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([id]), "s");
      await reportTimes(3, () => store.report(rec() as never));
      // 默认 demoteMinSamples=5：3 复发 + 1 被遵守 = 4 样本不足 → 仍 armed
      assert.equal(ruleById(store, id)?.status, "armed");
      store.configure({ demoteMinSamples: 1 });
      await store.report(rec() as never);
      assert.equal(ruleById(store, id)?.status, "demoted");
    });
  });

  describe("readJsonl 容错（事件流水）", () => {
    it("缺文件返回空", async () => {
      assert.deepEqual(readJsonl(path.join(scratch, "nope.jsonl")), []);
    });

    it("文件不可读（路径是目录）→ 空表，不抛", async () => {
      assert.deepEqual(readJsonl(scratch), []);
    });

    it("JSONL 坏行跳过并汇总 warn 一次", async () => {
      const file = path.join(scratch, LEDGER_FILE_NAME);
      writeFileSync(
        file,
        [
          JSON.stringify({ category: "c", signature: "s1", detail: "ok" }),
          "{不是 json",
          "42",
          "",
          "   ",
        ].join("\n"),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // 断言在下方
      });
      assert.equal(readJsonl(file).length, 1);
      assert.equal(warn.mock.calls.length, 1);
      assert.match(String(warn.mock.calls[0]?.[0]), /2 malformed lesson line/u);
      warn.mockRestore();
    });
  });

  describe("存量字段漂移逐字段归一（item 2）", () => {
    it("缺 evidence/sources 的存量卡：读入即补默认，report 不再永久抛错", async () => {
      seedRules([
        {
          id: "rule-legacy",
          project: PROJECT_KEY_FIXTURE,
          category: CATEGORY_GATE_FAILURE,
          signature: SIGNATURE_GATE_COMMAND,
          statement: "旧版本卡片没有 evidence/sources/recurrences/origin",
          status: "armed",
          createdAt: 1,
          updatedAt: 2,
          occurrences: 3,
          violation: 4,
          suppressed: 5,
        },
      ]);
      const store = freshStore();
      const card = store.rules()[0]!;
      assert.deepEqual(card.evidence, []);
      assert.deepEqual(card.sources, []);
      assert.equal(card.recurrences, 0);
      assert.equal(card.origin, "threshold");
      // 这条就是旧实现里抛 TypeError 的路径（rule.evidence.push / sources.includes）
      const receipt = await store.report(
        rec({
          category: CATEGORY_GATE_FAILURE,
          signature: SIGNATURE_GATE_COMMAND,
          detail: "再来一次",
        }) as never,
      );
      assert.equal(receipt.violationOf?.violation, 5);
      assert.equal(store.rules()[0]?.evidence.length, 1);
      assert.deepEqual(store.rules()[0]?.sources, [SOURCE_DANGER_GUARD]);
    });

    it("类型漂移：ts/计数写成字符串、status 未知、可选时间戳写成垃圾 → 全部归一", async () => {
      const seeded = seedRules([
        {
          id: "rule-drift",
          project: null,
          category: 7,
          signature: "  pnpm   check  ",
          statement: 99,
          status: "active",
          createdAt: "1700000000001",
          updatedAt: undefined,
          occurrences: "4",
          sources: SOURCE_DANGER_GUARD,
          violation: null,
          suppressed: Number.NaN,
          recurrences: true,
          armedAt: "yesterday",
          lastSeenAt: 1_700_000_000_002,
          lastViolationAt: "1700000000003",
          lastSuppressedAt: {},
          evidence: [
            null,
            5,
            { ts: "x", source: "unknown-bot", detail: 12 },
            { ts: 1, source: "", detail: "空来源退 manual" },
          ],
          origin: "robot",
        },
      ]);
      const [card] = seeded.persisted();
      assert.ok(card !== undefined);
      assert.equal(card.project, "default");
      assert.equal(card.category, "unknown");
      assert.equal(card.signature, SIGNATURE_GATE_COMMAND);
      assert.equal(card.statement, "");
      // 漂移状态退 archived：不注入、不度量，人工可 revive
      assert.equal(card.status, "archived");
      assert.equal(card.createdAt, 1_700_000_000_001);
      assert.equal(card.updatedAt, 0);
      assert.equal(card.occurrences, 4);
      assert.deepEqual(card.sources, []);
      assert.equal(card.violation, 0);
      assert.equal(card.suppressed, 0);
      assert.equal(card.recurrences, 0);
      assert.equal(card.origin, "threshold");
      assert.equal("armedAt" in card, false);
      assert.equal(card.lastSeenAt, 1_700_000_000_002);
      assert.equal(card.lastViolationAt, 1_700_000_000_003);
      assert.equal("lastSuppressedAt" in card, false);
      // source 是开放集：第三方插件自报的家门原样保留，只有空/非字符串才退 manual
      assert.deepEqual(card.evidence, [
        { ts: 0, source: "unknown-bot", detail: "" },
        { ts: 1, source: "manual", detail: "空来源退 manual" },
      ]);
    });

    it("无 id / 空 id 的行丢掉，其余照常读出", async () => {
      const seeded = seedRules([
        { category: "c", signature: "s", status: "armed" },
        { id: "", status: "armed", signature: "s" },
        { id: "rule-kept", category: "c", signature: "s", status: "armed" },
      ]);
      const rules = seeded.persisted();
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.id, "rule-kept");
    });

    it("可选时间戳齐备时原样读出（armedAt/lastSeenAt/lastViolationAt/lastSuppressedAt）", async () => {
      const store = freshStore();
      const receipt = await store.report(rec({ sessionId: "s-1" }) as never);
      const { id } = receipt.candidate!;
      await store.ruleAction(id, "arm");
      // pass 传的是细签名（路径），键折叠后仍要命中同一张卡——键漂移回归
      assert.equal(
        store.pass(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, SIGNATURE_PATH_A)?.id,
        id,
      );
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([id]), "s-1");
      // 表外类别的另一张卡：不碰上面这张 armed 卡的 violation 记账
      await store.report(rawRec({ signature: SIGNATURE_PATH_OTHER }) as never);
      const [card] = facet.persisted();
      assert.equal(typeof card?.armedAt, "number");
      assert.equal(typeof card?.lastSeenAt, "number");
      assert.equal(typeof card?.lastSuppressedAt, "number");
      assert.equal("lastViolationAt" in (card ?? {}), false);
      // 教训行的 sessionId 是字符串 → 原样带出
      assert.equal(store.recentLessons()[0]?.sessionId, "s-1");
    });

    it("教训行漂移：非数字 ts/缺 project/source/detail/turn、evidence 非对象都归一", async () => {
      writeFileSync(
        lessonsFile(),
        [
          JSON.stringify({
            category: CATEGORY_GATE_FAILURE,
            signature: SIGNATURE_GATE_COMMAND,
            ts: "1700000000009",
            source: "ghost-plugin",
            project: null,
            detail: 42,
            turn: "3",
            sessionId: 77,
            evidence: ["not", "a", "record"],
          }),
          JSON.stringify({ category: "c", signature: "s", ts: null, turn: null, evidence: {} }),
          JSON.stringify({ category: "c", ts: 1 }),
        ].join("\n"),
      );
      const store = freshStore();
      const lessons = store.recentLessons();
      assert.equal(lessons.length, 2);
      const first = lessons[0]!;
      assert.equal(first.ts, 1_700_000_000_009);
      // source 开放集：自报家门非空且不超限就原样保留（下面第二行没写 source，才退 manual）
      assert.equal(first.source, "ghost-plugin");
      assert.equal(first.project, "default");
      assert.equal(first.detail, "");
      assert.equal(first.turn, 3);
      assert.equal("sessionId" in first, false);
      assert.equal("evidence" in first, false);
      const second = lessons[1]!;
      assert.equal(second.ts, 0);
      assert.equal(second.source, "manual");
      assert.equal(second.detail, "");
      assert.equal("turn" in second, false);
      assert.deepEqual(second.evidence, {});
      // 缺 signature 的行仍整行丢弃（ruleKey 的组成键，缺了无法归并）
      assert.equal(
        lessons.every((row) => "signature" in row),
        true,
      );
    });
  });

  describe("落盘失败可观测（规则库写不进）", () => {
    // 写失败的 error 日志形状另有专测（test/rules-namespace.test.ts），这里只断言回执
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {
        // 屏蔽热路径日志，保持报告可读
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("report 的每条回执都带 ok:false + reason（新卡/候选/armed/revive/只补证据）", async () => {
      facet = stuckFacet([
        stuckRow("s-cand", "candidate", { occurrences: 1 }),
        stuckRow("s-armed", "armed", { violation: 1 }),
        stuckRow("s-rej", "rejected", { recurrences: 2 }),
        stuckRow("s-arch", "archived"),
      ]);
      const store = makeStore();
      // 回执对象如实带本次改动（计划态不被回滚），但 ok/reason 讲真话：没存住
      const created = await store.report(rawRec({ signature: "s-new" }) as never);
      assert.equal(created.ok, false);
      assert.equal(created.reason, PERSIST_FAILED);
      assert.equal(created.ready, false);
      assert.equal(created.candidate?.occurrences, 1);
      const candidate = await store.report(rawRec({ signature: "s-cand" }) as never);
      assert.equal(candidate.reason, PERSIST_FAILED);
      assert.equal(candidate.candidate?.occurrences, 2);
      const violation = await store.report(rawRec({ signature: "s-armed" }) as never);
      assert.equal(violation.reason, PERSIST_FAILED);
      assert.equal(violation.violationOf?.violation, 2);
      const revived = await store.report(rawRec({ signature: "s-rej" }) as never);
      assert.equal(revived.ok, false);
      assert.equal(revived.reason, PERSIST_FAILED);
      assert.equal(revived.candidate?.status, "candidate");
      assert.equal(revived.ready, false, "没存住就不许催人工审");
      const settled = await store.report(rawRec({ signature: "s-arch" }) as never);
      assert.equal(settled.ok, false);
      assert.equal(settled.reason, PERSIST_FAILED);
      // 失败写不许破坏已持久化的库：既没被空库覆写，也没有半写
      const survivorIds = facet.persisted().map((row) => row.id);
      assert.deepEqual(survivorIds.toSorted(), ["s-arch", "s-armed", "s-cand", "s-rej"]);
      assert.equal(facet.persisted().find((row) => row.id === "s-cand")?.occurrences, 1);
    });

    it("达 promoteThreshold 的新卡在无法落盘时不报 ready", async () => {
      facet = stuckFacet();
      const store = makeStore();
      const ready = await store.report(rawRec({ signature: "s1" }) as never);
      assert.equal(ready.ready, false);
      store.configure({ promoteThreshold: 1 });
      const second = await store.report(rawRec({ signature: "s2" }) as never);
      assert.equal(second.ok, false);
      assert.equal(second.ready, false);
    });

    it("ruleAction 没存住 → persist-failed（端点据此回 500），库里仍是旧状态", async () => {
      facet = stuckFacet([stuckRow("s-arm", "candidate")]);
      const store = makeStore();
      assert.equal(await store.ruleAction("s-arm", "arm"), "persist-failed");
      assert.equal(ruleById(store, "s-arm")?.status, "candidate", "失败写不得冒充已生效");
      assert.equal(await store.ruleAction("rule-nope", "arm"), "not-found");
      assert.equal(facet.provider.writesOf(SETTINGS_NAMESPACE), 0);
    });

    it("save 回执 rejected：一笔改动只写一次，绝不做无谓重试", async () => {
      const scripted = scriptedRulesRepository({ outcomes: ["rejected"] });
      const store = otherProcess(scripted.repo);
      const receipt = await store.report(rawRec({ signature: "s-drop" }) as never);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.reason, PERSIST_FAILED);
      // rejected 不是"该重试"（只有 conflict 才重读重放）：读一次、写一次就收手
      assert.equal(scripted.loads(), 1);
      assert.equal(scripted.saves(), 1);
      // 下一笔改动同样只写一次，且失败始终以回执对外——不抛到守卫热路径
      await store.report(rawRec({ signature: "s-drop-2" }) as never);
      assert.equal(scripted.saves(), 2);
    });

    it("conflict 连续超过 RULES_CAS_RETRY_LIMIT → 仍回执 PERSIST_FAILED 且不再重试", async () => {
      const scripted = scriptedRulesRepository({ outcomes: ["conflict"] });
      const store = otherProcess(scripted.repo);
      const receipt = await store.report(rawRec({ signature: "s-loop" }) as never);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.reason, PERSIST_FAILED);
      // 首次写 + 上限内的三次重放，然后收手（不越界、不死循环、不外抛）
      assert.equal(scripted.saves(), CAS_RETRY_LIMIT + 1);
      assert.equal(scripted.loads(), CAS_RETRY_LIMIT + 1);
    });

    it("conflict 后重放：重读确实发生，最终写回的数组含双方数据（映射 6）", async () => {
      const theirs = cardOf({ id: "peer", signature: "cmd-peer" });
      const scripted = scriptedRulesRepository({
        reads: [
          { cards: [], revision: 5 },
          { cards: [theirs], revision: 6 },
        ],
        outcomes: ["conflict", "persisted"],
      });
      const store = otherProcess(scripted.repo);
      const receipt = await store.report(rawRec({ signature: "cmd-mine" }) as never);
      assert.equal(receipt.ok, true);
      assert.equal(receipt.reason, undefined);
      assert.equal(scripted.loads(), 2, "冲突后必须重读，而不是拿旧数组再写");
      assert.equal(scripted.saves(), 2, "只用掉一次重试（远低于上限）");
      const [first, second] = scripted.batches();
      assert.deepEqual(
        first?.cards.map((row) => row.signature),
        ["cmd-mine"],
      );
      assert.equal(first.revision, 5);
      assert.deepEqual(second?.cards.map((row) => row.signature).toSorted(), [
        "cmd-mine",
        "cmd-peer",
      ]);
      assert.equal(second.revision, 6, "CAS 条件跟的是重读后的新 revision");
    });

    it("真 provider 的 revision 竞争走同一条重放路，两边卡都在", async () => {
      facet = makeRulesFacet();
      const store = makeStore();
      await store.report(rawRec({ signature: "cmd-a" }) as never);
      // 强制下一次写撞 SettingsConflictError（等价于"别处刚推进了 revision"）
      facet.provider.forceConflicts(1);
      const receipt = await store.report(rawRec({ signature: "cmd-b" }) as never);
      assert.equal(receipt.ok, true);
      assert.deepEqual(persistedSigsOf(facet), ["cmd-a", "cmd-b"]);
      assert.equal(
        facet.provider.loadsOf(SETTINGS_NAMESPACE),
        3,
        "一次写前重读 + 冲突后再重读一次",
      );
      assert.equal(facet.provider.writesOf(SETTINGS_NAMESPACE), 2, "首次写成功 + 重放写成功");
    });

    it("revive 达阈值时同样把落盘失败带回来", async () => {
      facet = stuckFacet([stuckRow("s-rev", "rejected", { recurrences: 2, occurrences: 2 })]);
      const store = makeStore();
      const revived = await store.report(rawRec({ signature: "s-rev" }) as never);
      assert.equal(revived.candidate?.status, "candidate");
      assert.equal(revived.ok, false);
      assert.equal(revived.reason, PERSIST_FAILED);
      assert.equal(ruleById(store, "s-rev")?.status, "rejected", "库里仍按旧状态读");
    });

    it("lessons.jsonl 写不进（父路径是文件）→ 只记日志，report 仍返回候选回执", async () => {
      const blocker = path.join(scratch, "afile");
      writeFileSync(blocker, "x");
      const store = new LessonStore({
        lessonsFile: path.join(blocker, "nested", LEDGER_FILE_NAME),
        rules: facet.repo,
        messages: () => MESSAGES.zh,
        now: () => 1_700_000_000_000,
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const receipt = await store.report(rec() as never);
      assert.equal(receipt.ok, true);
      assert.match(String(error.mock.calls[0]?.[0]), /lesson append failed/u);
      error.mockRestore();
    });
  });

  describe("trimJsonl / appendJsonl 磁盘保险丝", () => {
    it("单行超限且切到只剩 2 行 → 停手（不制造空文件、不截单行）", async () => {
      const file = path.join(scratch, "one.jsonl");
      const huge = `${"x".repeat(500)}\n`;
      writeFileSync(file, huge);
      trimJsonl(file, 10);
      assert.equal(readFileSync(file, "utf8"), huge);
      const two = `${"y".repeat(50)}\n${"z".repeat(50)}\n`;
      writeFileSync(file, two);
      trimJsonl(file, 10);
      // 半收缩到 ["zzz…", ""] 即 2 行：宁可超限也不清空用户的最后一行
      assert.equal(readFileSync(file, "utf8"), `${"z".repeat(50)}\n`);
    });

    it("半收缩时切点落在空行 → 去掉前置换行；仍超限则继续收缩", async () => {
      const file = path.join(scratch, "many.jsonl");
      writeFileSync(file, "aaaa\nbbbb\n\ncccc\n");
      trimJsonl(file, 3);
      assert.equal(readFileSync(file, "utf8"), "cccc\n");
      const big = path.join(scratch, "big.jsonl");
      writeFileSync(big, "1234567890\n".repeat(6));
      trimJsonl(big, 5);
      assert.ok(statSync(big).size <= 30);
      // 不存在的路径：尽力而为，不抛
      trimJsonl(path.join(scratch, "nope", "x.jsonl"), 5);
    });

    it("appendJsonl 自建缺失目录", async () => {
      const file = path.join(scratch, "deep", "nested", LEDGER_FILE_NAME);
      appendJsonl(file, { a: 1 }, 0);
      assert.equal(readJsonl(file).length, 1);
    });
  });

  describe("阈值与工具函数归一", () => {
    it("errorText（原 describeError，已收敛到 shared）：Error 取 message，其它抛出形态原样兜住", async () => {
      assert.equal(errorText(new Error("炸了")), "炸了");
      assert.equal(errorText("字符串抛出"), "字符串抛出");
    });

    it("normalizeSignature 非字符串 → 空串", async () => {
      assert.equal(normalizeSignature(42), "");
      assert.equal(normalizeSignature(null), "");
    });

    it("deriveProject：无斜杠/尾斜杠/空格目录都归一", async () => {
      assert.match(deriveProject("plain-repo"), /^plain-repo-[0-9a-f]{8}$/u);
      assert.match(deriveProject("/a/b/"), /^b-[0-9a-f]{8}$/u);
      assert.match(deriveProject("/a/my repo"), /^my_repo-[0-9a-f]{8}$/u);
      assert.equal(deriveProject("   "), "default");
      assert.equal(deriveProject("//"), "default");
    });

    it("draftStatement 覆盖每个已知分类", async () => {
      assert.match(draftStatement("dangerous-bash", "rm -rf", MESSAGES.zh), /危险 shell/u);
      assert.match(draftStatement(CATEGORY_SECRET_PATH, ".env", MESSAGES.zh), /密钥/u);
      assert.match(
        draftStatement(CATEGORY_TRANSIENT_FAILURE, "cavoti code", MESSAGES.zh),
        /瞬时失败/u,
      );
      assert.match(draftStatement("max-tokens", "sig", MESSAGES.zh), /分段交付/u);
      assert.match(draftStatement("unfinished-turn", "sig", MESSAGES.zh), /勾一项/u);
      assert.equal(draftStatement(CATEGORY_FEEDBACK_DIGEST, "模型原话", MESSAGES.zh), "模型原话");
    });

    it("promoteThreshold / reviveThreshold 非法值退默认，越界值收敛", async () => {
      const store = new LessonStore({
        lessonsFile: path.join(scratch, LEDGER_FILE_NAME),
        rules: facet.repo,
        promoteThreshold: "not-a-number" as never,
        reviveThreshold: 99,
        messages: () => MESSAGES.zh,
        now: () => 1_700_000_000_000,
      });
      // 非法 promoteThreshold → 默认 3：前两次不 ready，第三次才 ready
      const firstReport = await store.report(rawRec({ signature: "sig-a" }) as never);
      assert.equal(firstReport.ready, false);
      const secondReport = await store.report(rawRec({ signature: "sig-a" }) as never);
      assert.equal(secondReport.ready, false);
      const thirdReport = await store.report(rawRec({ signature: "sig-a" }) as never);
      assert.equal(thirdReport.ready, true);
      // reviveThreshold 99 → 收敛到 20：第 19 次复发仍 rejected，第 20 次回候选
      const rejectedReport = await store.report(rawRec({ signature: "sig-b" }) as never);
      const rejectedId = rejectedReport.candidate!.id;
      await store.ruleAction(rejectedId, "reject");
      await reportTimes(19, () => store.report(rawRec({ signature: "sig-b" }) as never));
      assert.equal(ruleById(store, rejectedId)?.status, "rejected");
      await store.report(rawRec({ signature: "sig-b" }) as never);
      assert.equal(ruleById(store, rejectedId)?.status, "candidate");
      // 非法 reviveThreshold → 默认 3
      const store2 = new LessonStore({
        lessonsFile: path.join(scratch, "lessons2.jsonl"),
        rules: makeRulesFacet().repo,
        reviveThreshold: Number.NaN,
        messages: () => MESSAGES.zh,
        now: () => 1_700_000_000_000,
      });
      const secondReceipt = await store2.report(rawRec({ signature: "sig-c" }) as never);
      const second = secondReceipt.candidate!;
      await store2.ruleAction(second.id, "reject");
      await store2.report(rawRec({ signature: "sig-c" }) as never);
      await store2.report(rawRec({ signature: "sig-c" }) as never);
      assert.equal(ruleById(store2, second.id)?.status, "rejected");
      await store2.report(rawRec({ signature: "sig-c" }) as never);
      assert.equal(ruleById(store2, second.id)?.status, "candidate");
    });

    it("configure 忽略非数值与白名单外的键", async () => {
      const store = makeStore();
      store.configure({ promoteThreshold: 2, maxLessonsBytes: Number.NaN });
      const seededReceipt = await store.report(rawRec({ signature: "a" }) as never);
      assert.equal(seededReceipt.candidate?.occurrences, 1);
      const promotedReceipt = await store.report(rawRec({ signature: "a" }) as never);
      assert.equal(promotedReceipt.ready, true);
      store.configure({ legacyKey: 7 } as never);
      store.configure({ decayDays: 5 });
      assert.equal(store.rules().length, 1);
    });

    it("setMaxLessonsBytes：非法值一律退 0（不设上限）", async () => {
      const store = makeStore();
      store.setMaxLessonsBytes(Number.NaN);
      store.setMaxLessonsBytes(-1);
      store.setMaxLessonsBytes(4096);
      await store.report(rec({ detail: "d".repeat(50) }) as never);
      assert.equal(store.lessonsCount(), 1);
    });
  });

  describe("度量与衰减补充分支", () => {
    it("decayVerdict 锚点回退链：lastViolationAt > lastSuppressedAt > armedAt > createdAt", async () => {
      const t0 = 1_700_000_000_000;
      const base: RuleCard = {
        id: "r",
        project: "p",
        category: "c",
        signature: "s",
        statement: "t",
        status: "armed",
        createdAt: t0,
        updatedAt: t0,
        occurrences: 1,
        sources: [],
        violation: 0,
        suppressed: 0,
        samples: 0,
        recurrences: 0,
        evidence: [],
        origin: "threshold",
      };
      const late = t0 + 365 * 86_400_000;
      assert.equal(
        decayVerdict({ ...base, lastSuppressedAt: late, suppressed: 1 }, DEFAULT_DECAY, late),
        "keep",
      );
      assert.equal(
        decayVerdict(
          { ...base, armedAt: late, violation: 1, lastViolationAt: late },
          DEFAULT_DECAY,
          late,
        ),
        "keep",
      );
      assert.equal(decayVerdict({ ...base, armedAt: t0 }, DEFAULT_DECAY, late), "undeterminable");
      // 三个锚点全缺 → 回退到 createdAt
      assert.equal(decayVerdict(base, DEFAULT_DECAY, late), "undeterminable");
    });

    it("pass 只认 armed 卡；非 armed 与不匹配键都返回 undefined", async () => {
      const store = makeStore();
      const receipt = await store.report(rec({ signature: STABLE_SIG_FACTGATE }) as never);
      const { id } = receipt.candidate!;
      assert.equal(
        store.pass(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE),
        undefined,
      );
      await store.ruleAction(id, "arm");
      assert.equal(
        store.pass(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE)?.id,
        id,
      );
      assert.equal(
        store.pass("other-project", CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE),
        undefined,
      );
      // 无 sessionId 的收尾清算：只记账不写日志
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([id]));
      assert.equal(ruleById(store, id)?.suppressed, 1);
      assert.equal(info.mock.calls.length, 0);
      info.mockRestore();
    });

    it("runDecay 能把已积累的高复发率规则降级", async () => {
      const store = makeStore({ demoteMinSamples: 100 });
      const receipt = await store.report(rec() as never);
      const { id } = receipt.candidate!;
      await store.ruleAction(id, "arm");
      await reportTimes(4, () => store.report(rec() as never));
      assert.equal(ruleById(store, id)?.status, "armed");
      // 降级要有分母：先让这条规则被 pass 一次并在会话收尾计为干净命中（suppressed）。
      const hit = store.pass(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, SIGNATURE_PATH_A);
      assert.ok(hit !== undefined, "armed 规则应可被 pass 命中");
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([hit.id]), "s-clean");
      store.configure({ demoteMinSamples: 1, demoteThreshold: 3 });
      const out = await store.runDecay();
      assert.equal(out.demoted, 1);
      assert.equal(ruleById(store, id)?.status, "demoted");
    });

    it("addCandidate 命中 armed/rejected/archived 键：只并回、不新建、不改状态", async () => {
      const store = makeStore();
      // 表外类别：三张卡要各自独立（登记类别会被折叠成一张）
      const keepReceipt = await store.report(rawRec({ signature: "keep-me" }) as never);
      const { id } = keepReceipt.candidate!;
      await store.ruleAction(id, "arm", "人工规则");
      const rejReceipt = await store.report(rawRec({ signature: "rej-me" }) as never);
      const rejected = rejReceipt.candidate!;
      await store.ruleAction(rejected.id, "reject");
      const arcReceipt = await store.report(rawRec({ signature: "arc-me" }) as never);
      const archived = arcReceipt.candidate!;
      await store.ruleAction(archived.id, "archive");
      const armedCard = await store.addCandidate({
        project: PROJECT_KEY_FIXTURE,
        category: CATEGORY_GATE_FAILURE,
        signature: "keep-me",
        statement: "模型想改写的正文",
        detail: "蒸馏上下文",
      });
      const rejectedCard = await store.addCandidate({
        project: PROJECT_KEY_FIXTURE,
        category: CATEGORY_GATE_FAILURE,
        signature: "rej-me",
        statement: "模型想改写的正文",
        detail: "蒸馏上下文",
        source: "manual",
      });
      const archivedCard = await store.addCandidate({
        project: PROJECT_KEY_FIXTURE,
        category: CATEGORY_GATE_FAILURE,
        signature: "arc-me",
        statement: "模型想改写的正文",
        detail: "蒸馏上下文",
      });
      assert.equal(armedCard.id, id);
      assert.equal(armedCard.status, "armed");
      assert.equal(armedCard.statement, "人工规则");
      assert.equal(armedCard.occurrences, 1);
      assert.equal(rejectedCard.id, rejected.id);
      assert.equal(rejectedCard.status, "rejected");
      assert.equal(rejectedCard.occurrences, 1);
      assert.equal(rejectedCard.evidence.at(-1)?.source, "manual");
      assert.equal(archivedCard.id, archived.id);
      assert.equal(archivedCard.status, "archived");
      assert.equal(store.rules().length, 3);
      assert.equal(archivedCard.evidence.length, 2);
    });
  });

  describe("碎片迁移补充分支（存量库）", () => {
    it("已存在 stable 候选卡 + armed 碎片：人工升格决定继承到主卡", async () => {
      const store = seedStore([
        diskRow({
          id: "stable",
          signature: STABLE_SIG_FACTGATE,
          statement: "已存在的稳定候选卡",
        }),
        diskRow({
          id: "fa",
          signature: SIGNATURE_PATH_A,
          status: "armed",
          armedAt: 5,
          statement: "更晚一次升格",
        }),
        diskRow({ id: "fb", signature: SIGNATURE_PATH_B, status: "rejected" }),
      ]);
      const merged = await store.migrateFragmentRules();
      const primary = ruleById(store, "stable")!;
      // 主卡就是已存在的 stable 候选卡，且继承了 armed 状态与人工正文
      assert.equal(merged, 1);
      assert.equal(primary.signature, CATEGORY_SIGNATURES[CATEGORY_FACTGATE_DENY]);
      assert.equal(primary.status, "armed");
      assert.equal(primary.statement, "更晚一次升格");
      assert.equal(typeof primary.armedAt, "number");
      assert.equal(primary.occurrences, 2);
      assert.equal(store.rules().length, 2);
    });

    it("被人工 revive 过的 :rejected 汇总卡：新碎片并回，但不退回 rejected", async () => {
      const store = seedStore([
        diskRow({
          id: "sum",
          signature: STABLE_SIG_FACTGATE_REJECTED,
          status: "candidate",
          evidence: [ev("汇总卡原有证据")],
        }),
        diskRow({
          id: "f2",
          signature: SIGNATURE_PATH_D,
          status: "rejected",
          evidence: [ev("新碎片")],
        }),
      ]);
      const merged = await store.migrateFragmentRules();
      const summary = ruleById(store, "sum")!;
      assert.equal(merged, 1);
      assert.equal(summary.status, "candidate");
      assert.equal(summary.signature, STABLE_SIG_FACTGATE_REJECTED);
      assert.equal(summary.evidence.length, 2);
    });

    it("两张 armed 碎片 + 一张候选：first armed 作主卡，第二张仍并证据", async () => {
      const store = seedStore([
        diskRow({
          id: "fe",
          signature: "/repo/src/e.ts",
          status: "armed",
          armedAt: 5,
          statement: "先升格的规则",
        }),
        diskRow({
          id: "ff",
          signature: "/repo/src/f.ts",
          status: "armed",
          armedAt: 5,
          statement: "后升格的规则",
        }),
      ]);
      const merged = await store.migrateFragmentRules();
      const rules = store.rules();
      assert.equal(rules.length, 1);
      assert.equal(merged, 1);
      assert.equal(rules[0]?.status, "armed");
      // mergeFragment：更晚 armed 的碎片覆盖主卡正文与生效时间（同一次升格不覆盖）
      assert.equal(rules[0].statement, "先升格的规则");
      assert.equal(rules[0].occurrences, 2);
      assert.equal(rules[0].evidence.length, 2);
      assert.equal(ruleById(store, "ff"), undefined);
    });

    it("demoted 与 archived 碎片不参与迁移", async () => {
      const store = seedStore([
        diskRow({ id: "fg", signature: "/repo/src/g.ts", status: "demoted" }),
        diskRow({ id: "fh", signature: "/repo/src/h.ts", status: "archived" }),
      ]);
      assert.equal(await store.migrateFragmentRules(), 0);
      assert.equal(store.rules().length, 2);
    });
  });

  describe("归并继承 armed 度量的完整形态（漂移库 + 时间戳搬迁）", () => {
    it("armed 碎片的时间戳齐备 → 主卡逐条继承（含 lastSeenAt 取更晚）", async () => {
      seedRules([
        "a bare string row",
        42,
        stableCandidateRow({ lastSeenAt: 100 }),
        armedFragmentRow({
          armedAt: 200,
          lastViolationAt: 210,
          lastSuppressedAt: 220,
          lastSeenAt: 300,
        }),
      ]);
      const store = freshStore();
      assert.equal(await store.migrateFragmentRules(), 1);
      const [primary] = store.rules();
      assert.equal(primary?.id, "s-stable");
      assert.equal(primary.status, "armed");
      assert.equal(primary.armedAt, 200);
      assert.equal(primary.violation, 2);
      assert.equal(primary.suppressed, 3);
      assert.equal(primary.lastViolationAt, 210);
      assert.equal(primary.lastSuppressedAt, 220);
      assert.equal(primary.lastSeenAt, 300);
      // mergeFragment：更晚 armed 的碎片覆盖主卡正文
      assert.equal(primary.statement, "armed 碎片正文");
    });

    it("armed 碎片缺全部可选时间戳 → 主卡的旧值被删掉（不留陈旧锚点）", async () => {
      seedRules([
        stableCandidateRow({ armedAt: 9, lastViolationAt: 9, lastSuppressedAt: 9 }),
        armedFragmentRow({}),
      ]);
      const store = freshStore();
      assert.equal(await store.migrateFragmentRules(), 1);
      const [primary] = store.rules();
      assert.equal(primary?.status, "armed");
      assert.equal("armedAt" in primary, false);
      assert.equal("lastViolationAt" in primary, false);
      assert.equal("lastSuppressedAt" in primary, false);
      assert.equal(primary.lastSeenAt, undefined);
    });
  });

  describe("ruleAction 全动作", () => {
    it("edit 带正文才改写；空正文保留原文", async () => {
      const store = makeStore();
      const receipt = await store.report(rec() as never);
      const { id } = receipt.candidate!;
      const original = ruleById(store, id)!.statement;
      assert.equal(await store.ruleAction(id, "edit", "   "), "persisted");
      assert.equal(ruleById(store, id)?.statement, original);
      await store.ruleAction(id, "edit", "  人工改写  ");
      assert.equal(ruleById(store, id)?.statement, "人工改写");
      await store.ruleAction(id, "edit");
      assert.equal(ruleById(store, id)?.statement, "人工改写");
      assert.equal(ruleById(store, id)?.status, "candidate");
    });

    it("archive / revive / demote / reject 的状态流转", async () => {
      const store = makeStore();
      const receipt = await store.report(rec() as never);
      const { id } = receipt.candidate!;
      await store.ruleAction(id, "archive");
      assert.equal(ruleById(store, id)?.status, "archived");
      await store.ruleAction(id, "revive");
      assert.equal(ruleById(store, id)?.status, "candidate");
      await store.ruleAction(id, "arm");
      await store.report(rec() as never);
      await store.ruleAction(id, "demote");
      assert.equal(ruleById(store, id)?.status, "demoted");
      await store.ruleAction(id, "revive");
      assert.equal(ruleById(store, id)?.status, "candidate");
      await store.ruleAction(id, "reject");
      assert.equal(ruleById(store, id)?.status, "rejected");
      assert.equal(await store.ruleAction("no-such-id", "archive"), "not-found");
    });
  });

  // ── Part 1：签名归一走写入侧 ────────────────────────────────────────────

  describe("签名归一走写入侧（稳定签名进键，细签名进证据）", () => {
    it("同类别两条不同路径汇聚成一张卡：occurrences=2，两个路径都在 evidence", async () => {
      const store = makeStore();
      const one = await store.report(
        rec({
          category: CATEGORY_SECRET_PATH,
          signature: SIGNATURE_SECRET_PATH,
          detail: "deny a",
        }) as never,
      );
      const two = await store.report(
        rec({
          category: CATEGORY_SECRET_PATH,
          signature: SIGNATURE_SECRET_PATH_PROD,
          detail: "deny b",
        }) as never,
      );
      assert.equal(one.candidate?.id, two.candidate?.id);
      const rules = store.rules();
      assert.equal(rules.length, 1);
      const [card] = rules;
      assert.equal(card?.signature, CATEGORY_SIGNATURES[CATEGORY_SECRET_PATH]);
      assert.equal(card?.occurrences, 2);
      assert.deepEqual(
        card.evidence.map((row) => row.signature),
        [SIGNATURE_SECRET_PATH, SIGNATURE_SECRET_PATH_PROD],
      );
      assert.deepEqual(
        card.evidence.map((row) => row.detail),
        ["deny a", "deny b"],
      );
      // 键折叠后规则正文不再嵌具体路径（碎片时代的"每文件一条规则"就是从这里来的）
      assert.match(card.statement, /不要编辑密钥/u);
      assert.equal(card.statement.includes(SIGNATURE_SECRET_PATH), false);
      // 证据行经端口往返仍带得回原始签名
      const [reloaded] = facet.persisted();
      assert.equal(reloaded?.evidence[1]?.signature, SIGNATURE_SECRET_PATH_PROD);
    });

    it("表外类别保持自有签名；未折叠时 evidence 不重复存一份签名", async () => {
      const store = makeStore();
      await store.report(rawRec({ signature: "  /repo/src/a.ts " }) as never);
      await store.report(rawRec({ signature: SIGNATURE_GATE_COMMAND }) as never);
      const rules = store.rules();
      assert.equal(rules.length, 2);
      assert.deepEqual(
        rules.map((row) => row.signature),
        [SIGNATURE_PATH_A, SIGNATURE_GATE_COMMAND],
      );
      assert.equal("signature" in (rules[0]?.evidence[0] ?? {}), false);
    });

    it("report() 写得进的键，ruleKey/pass() 一定查得到（键漂移回归）", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec({ signature: SIGNATURE_PATH_Z }) as never);
      const { id } = candidate!;
      await store.ruleAction(id, "arm");
      // pass 传上报时的细签名：折叠后与写入侧同键，必须命中同一张 armed 卡
      assert.equal(
        store.pass(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, SIGNATURE_PATH_Z)?.id,
        id,
      );
      const folded = stableSignatureFor(CATEGORY_FACTGATE_DENY, SIGNATURE_PATH_Z);
      assert.equal(folded, STABLE_SIG_FACTGATE);
      // ruleKey 只管三段拼接，折叠在 stableSignatureFor：同一类别的任意细签名算出的
      // 都是这一个键，且库里只有一张卡带着它（写侧与查侧同源，不存在第二份键形态）。
      const key = ruleKey(PROJECT_KEY_FIXTURE, CATEGORY_FACTGATE_DENY, folded);
      assert.equal(
        key,
        ruleKey(
          PROJECT_KEY_FIXTURE,
          CATEGORY_FACTGATE_DENY,
          stableSignatureFor(CATEGORY_FACTGATE_DENY, SIGNATURE_PATH_OTHER),
        ),
      );
      assert.equal(
        store.rules().filter((row) => ruleKey(row.project, row.category, row.signature) === key)
          .length,
        1,
      );
      assert.equal(ruleById(store, id)?.signature, folded);
      // 同类别另一条路径同样命中这张卡 → violation++（碎片时代永远命中不到）
      const again = await store.report(rec({ signature: SIGNATURE_PATH_OTHER }) as never);
      assert.equal(again.violationOf?.id, id);
      assert.equal(again.violationOf.violation, 1);
    });

    it("stableSignatureFor：表内折叠且幂等，表外原样，原型链同名类别不被误读", async () => {
      assert.equal(stableSignatureFor(CATEGORY_FACTGATE_DENY, "/a/b.ts"), STABLE_SIG_FACTGATE);
      assert.equal(
        stableSignatureFor(CATEGORY_FACTGATE_DENY, STABLE_SIG_FACTGATE),
        STABLE_SIG_FACTGATE,
      );
      assert.equal(stableSignatureFor(CATEGORY_SECRET_PATH, "  a  b "), STABLE_SIG_SECRET_PATH);
      assert.equal(
        stableSignatureFor(CATEGORY_GATE_FAILURE, MESSY_GATE_SIGNATURE),
        SIGNATURE_GATE_COMMAND,
      );
      // Object 索引会带出 toString/constructor 等原型成员——查表必须走 Map
      assert.equal(stableSignatureFor("toString", "sig"), "sig");
      assert.equal(stableSignatureFor("constructor", "sig"), "sig");
      assert.equal(stableSignatureFor(CATEGORY_GATE_FAILURE, 42), "");
    });

    it("secret-path 正文：稳定签名走类别级文案，未折叠仍嵌具体文件", async () => {
      assert.equal(
        draftStatement(CATEGORY_SECRET_PATH, STABLE_SIG_SECRET_PATH, MESSAGES.zh),
        "不要编辑密钥/凭据类文件（.env、*.key、token 配置等）；确需变更时先征得用户明确同意，并最小化接触面。",
      );
      assert.match(
        draftStatement(CATEGORY_SECRET_PATH, SIGNATURE_SECRET_PATH, MESSAGES.zh),
        /\/repo\/\.env/u,
      );
    });

    it("report 建卡即存 cwd，端口往返读回；无 cwd 的卡不长出空键", async () => {
      const store = makeStore();
      const { candidate } = await store.report(rec({ cwd: CANON_CWD }) as never);
      assert.equal(candidate?.cwd, CANON_CWD);
      const [reloaded] = facet.persisted();
      assert.equal(reloaded?.cwd, CANON_CWD);
      const [bare] = seedRules([diskRow({ id: "nc", signature: STABLE_SIG_FACTGATE })]).persisted();
      assert.equal("cwd" in (bare ?? {}), false);
    });

    it("存量卡缺 cwd 时由后续同键教训补齐；已有 cwd 不被后来者覆盖", async () => {
      const store = seedStore([diskRow({ id: "no-cwd", signature: STABLE_SIG_FACTGATE })]);
      await store.report(rec({ cwd: CANON_CWD }) as never);
      assert.equal(ruleById(store, "no-cwd")?.cwd, CANON_CWD);
      await store.report(rec({ cwd: "/repo/other" }) as never);
      assert.equal(ruleById(store, "no-cwd")?.cwd, CANON_CWD, "已有 cwd 不被覆盖");
    });

    it("教训不带 cwd 时，卡片保持无 cwd（不写 undefined 键）", async () => {
      const store = seedStore([diskRow({ id: "no-cwd2", signature: STABLE_SIG_FACTGATE })]);
      await store.report(rec() as never);
      assert.equal("cwd" in (ruleById(store, "no-cwd2") ?? {}), false);
    });

    it("evidence.signature 漂移（数字 / 空串）按未折叠归一，不写空键", async () => {
      const seeded = seedRules([
        diskRow({
          id: "e-dirty",
          signature: STABLE_SIG_FACTGATE,
          evidence: [
            { ts: 1, source: SOURCE_DANGER_GUARD, detail: "d", signature: 7 },
            { ts: 2, source: "manual", detail: "e", signature: "" },
          ],
        }),
      ]);
      const [card] = seeded.persisted();
      assert.equal("signature" in (card?.evidence[0] ?? {}), false);
      assert.equal("signature" in (card?.evidence[1] ?? {}), false);
    });
  });

  // ── Part 2：project 键单源 + 一次性归一迁移 ─────────────────────────────
  // 期望值是 shared/lib/project-key.ts 的产物，串在这里是刻意的字面量锚点：
  //   LEGACY = 旧"纯字符串归一"下 `/repo/other/../proj` 的桶键；
  //   CANON  = 规范归一（path.resolve 吃掉 `..`）后同一目录的桶键。
  // 两者不同正是本迁移要收拢的那类分桶。

  const LEGACY_KEY = "proj-93e3dace";
  const CANON_KEY = "proj-6b906b9c";
  const DIRTY_CWD = "/repo/other/../proj";
  // CANON_CWD 上移到模块作用域：cwd 归一的用例在别的 describe 块里也要用。

  describe("migrateProjectKeys：project 键单源与一次性归一", () => {
    it("旧键（cwd 带 `..` 冗余段）改写到规范键，第二次跑是 no-op", async () => {
      const store = seedStore([
        diskRow({
          id: "k1",
          project: LEGACY_KEY,
          cwd: DIRTY_CWD,
          signature: STABLE_SIG_FACTGATE,
        }),
      ]);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 1, merged: 0 });
      assert.equal(store.rules()[0]?.project, CANON_KEY);
      // 重开一个实例读盘再跑：project 已等于 deriveProjectKey(cwd) → 零改动
      const reloaded = seedStore(store.rules());
      assert.deepEqual(await reloaded.migrateProjectKeys(), { rewrites: 0, merged: 0 });
      assert.equal(reloaded.rules()[0]?.project, CANON_KEY);
      assert.equal(reloaded.rules()[0]?.id, "k1");
    });

    it("规范绝对路径的卡：重算等于自身 → 零改写（存量桶不迁移）", async () => {
      const store = seedStore([
        diskRow({
          id: "k0",
          project: CANON_KEY,
          cwd: CANON_CWD,
          signature: STABLE_SIG_FACTGATE,
        }),
      ]);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 0, merged: 0 });
      assert.equal(store.rules()[0]?.project, CANON_KEY);
    });

    it("没有 cwd（或 cwd 是空串）的卡原样不动：绝不猜键", async () => {
      const store = seedStore([
        diskRow({ id: "n1", project: LEGACY_KEY, signature: STABLE_SIG_FACTGATE }),
        diskRow({ id: "n2", project: LEGACY_KEY, cwd: "", signature: SIGNATURE_GATE_COMMAND }),
      ]);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 0, merged: 0 });
      assert.deepEqual(
        store.rules().map((rule) => rule.project),
        [LEGACY_KEY, LEGACY_KEY],
      );
    });

    it("两张卡重算后撞同键：合并，证据不丢，人工 rejected 不被候选卡覆盖", async () => {
      const store = seedStore([
        diskRow({
          id: "c1",
          project: LEGACY_KEY,
          cwd: DIRTY_CWD,
          signature: STABLE_SIG_FACTGATE,
          status: "rejected",
          evidence: [ev("被拒的旧键卡")],
        }),
        diskRow({
          id: "c2",
          project: CANON_KEY,
          cwd: CANON_CWD,
          signature: STABLE_SIG_FACTGATE,
          status: "candidate",
          occurrences: 5,
          evidence: [ev("规范键候选卡")],
        }),
      ]);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 1, merged: 1 });
      const rules = store.rules();
      assert.equal(rules.length, 1);
      const [kept] = rules;
      // 主卡是被重算过来的那张 rejected：人工决定优先，机器累积的候选卡并进来
      assert.equal(kept?.id, "c1");
      assert.equal(kept.project, CANON_KEY);
      assert.equal(kept.status, "rejected");
      assert.equal(kept.occurrences, 6);
      assert.deepEqual(
        kept.evidence.map((row) => row.detail),
        ["被拒的旧键卡", "规范键候选卡"],
      );
      assert.equal(ruleById(store, "c2"), undefined);
    });

    it("撞键的后来者是 armed 卡：人工升格的一方当主卡，先到候选被并掉", async () => {
      const store = seedStore([
        diskRow({
          id: "a1",
          project: "one-b4b81874",
          cwd: "/w/one",
          signature: STABLE_SIG_FACTGATE,
          status: "candidate",
          occurrences: 9,
        }),
        diskRow({
          id: "a2",
          project: "two-23fa702a",
          cwd: "/w/one",
          signature: STABLE_SIG_FACTGATE,
          status: "armed",
          armedAt: 5,
          statement: "人工升格的规则",
        }),
      ]);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 1, merged: 1 });
      const rules = store.rules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.id, "a2");
      assert.equal(rules[0].status, "armed");
      assert.equal(rules[0].statement, "人工升格的规则");
      assert.equal(rules[0].occurrences, 10);
      assert.equal(rules[0].violation, 0);
      assert.equal(ruleById(store, "a1"), undefined);
    });

    it("同级撞键取观察次数多者当主卡（两个方向都成立）", async () => {
      const stable = { category: CATEGORY_GATE_FAILURE, signature: SIGNATURE_GATE_COMMAND };
      const busiestFirst = seedStore([
        diskRow({
          ...stable,
          id: "b1",
          project: LEGACY_KEY,
          cwd: DIRTY_CWD,
          occurrences: 3,
          evidence: [ev("b1")],
        }),
        diskRow({
          ...stable,
          id: "b2",
          project: CANON_KEY,
          cwd: CANON_CWD,
          occurrences: 1,
          evidence: [ev("b2")],
        }),
      ]);
      assert.deepEqual(await busiestFirst.migrateProjectKeys(), { rewrites: 1, merged: 1 });
      assert.equal(busiestFirst.rules()[0]?.id, "b1");
      assert.equal(busiestFirst.rules()[0]?.occurrences, 4);
      assert.equal(busiestFirst.rules()[0]?.signature, SIGNATURE_GATE_COMMAND);

      const busiestSecond = seedStore([
        diskRow({
          ...stable,
          id: "b1",
          project: LEGACY_KEY,
          cwd: DIRTY_CWD,
          occurrences: 1,
          evidence: [ev("b1")],
        }),
        diskRow({
          ...stable,
          id: "b2",
          project: CANON_KEY,
          cwd: CANON_CWD,
          occurrences: 3,
          evidence: [ev("b2")],
        }),
      ]);
      assert.deepEqual(await busiestSecond.migrateProjectKeys(), { rewrites: 1, merged: 1 });
      assert.equal(busiestSecond.rules()[0]?.id, "b2");
      assert.equal(busiestSecond.rules()[0]?.project, CANON_KEY);
      assert.equal(ruleById(busiestSecond, "b1"), undefined);
    });

    it("与碎片迁移同时跑：先收签名碎片再重算 project，两轮都幂等", async () => {
      const store = seedStore([
        diskRow({ id: "m1", project: LEGACY_KEY, cwd: DIRTY_CWD, signature: SIGNATURE_PATH_A }),
        diskRow({ id: "m2", project: CANON_KEY, cwd: CANON_CWD, signature: SIGNATURE_PATH_B }),
      ]);
      assert.equal(await store.migrateFragmentRules(), 0);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 1, merged: 1 });
      const rules = store.rules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.signature, STABLE_SIG_FACTGATE);
      assert.equal(rules[0].project, CANON_KEY);
      assert.equal(rules[0].occurrences, 2);
      assert.equal(rules[0].evidence.length, 2);
      assert.equal(await store.migrateFragmentRules(), 0);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 0, merged: 0 });
    });

    it("report() 建的卡同时带规范 project 与 cwd：装载期迁移不再碰它", async () => {
      const store = makeStore();
      const { candidate } = await store.report(
        rec({ cwd: DIRTY_CWD, project: deriveProject(DIRTY_CWD) }) as never,
      );
      assert.equal(candidate?.project, CANON_KEY);
      assert.equal(candidate.cwd, DIRTY_CWD);
      assert.deepEqual(await store.migrateProjectKeys(), { rewrites: 0, merged: 0 });
    });

    it("deriveProject 与 shared 派生同源：同一 cwd 两种写法同键", async () => {
      assert.equal(deriveProject("/repo//proj///"), deriveProject(CANON_CWD));
      assert.equal(deriveProject(DIRTY_CWD), CANON_KEY);
      assert.equal(deriveProject(CANON_CWD), CANON_KEY);
    });
  });

  // ── Part 3：度量双计数（violation / observed=suppressed / samples）与不可判定 ──

  describe("度量双计数与不可判定裁决", () => {
    const t0 = 1_700_000_000_000;
    // 纯裁决用的 armed 卡（transient-failure：现实中宿主不发 pass，观察数恒为 0）。
    const armedCard = (over: Partial<RuleCard>): RuleCard => ({
      id: "r",
      project: "p",
      category: CATEGORY_TRANSIENT_FAILURE,
      signature: "s",
      statement: "t",
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
    });

    it("violation=5 / observed=0 / samples=40 → 不降级：无干净观测即无分母，判不可判定", async () => {
      const policy: DecayPolicy = { ...DEFAULT_DECAY, demoteMinSamples: 10 };
      // 关键回归：suppressed 为 0 时复发率结构上恒为 1.0（分母只剩违规自己），
      // 宿主不发 pass 的类别（transient-failure）会因此被自己的分子判有罪。
      assert.equal(
        decayVerdict(armedCard({ violation: 5, samples: 40 }), policy, t0),
        "undeterminable",
      );
      // 违规还没攒到门槛时不必急着点出来，等它成熟或被测到再说。
      assert.equal(
        decayVerdict(
          armedCard({ violation: 1, samples: 3 }),
          { ...DEFAULT_DECAY, demoteThreshold: 2 },
          t0,
        ),
        "keep",
      );
    });

    it("violation=5 / observed=5 / samples=40 → 降级（复发率 5/10 达标，samples 不进分母）", async () => {
      const policy: DecayPolicy = { ...DEFAULT_DECAY, demoteMinSamples: 10 };
      // 若 samples 被误并进分母，5/(5+5+40)=0.1 < 0.5 会留 armed；期望 demote 正证否之。
      assert.equal(
        decayVerdict(armedCard({ violation: 5, suppressed: 5, samples: 40 }), policy, t0),
        "demote",
      );
    });

    it("干净但从没被观察到的 armed 规则超 decayDays → 不可判定（既不降级也不归档）", async () => {
      const policy: DecayPolicy = { ...DEFAULT_DECAY, decayDays: 30 };
      assert.equal(
        decayVerdict(armedCard({ samples: 40 }), policy, t0 + 31 * 86_400_000),
        "undeterminable",
      );
    });

    it("存量库无 samples 字段：读入默认 0，且既有 violation/suppressed 计数不丢", async () => {
      const [card] = seedRules([
        {
          id: "legacy-no-samples",
          project: PROJECT_KEY_FIXTURE,
          category: CATEGORY_GATE_FAILURE,
          signature: SIGNATURE_GATE_COMMAND,
          statement: "旧版本卡片没有 samples 字段",
          status: "armed",
          createdAt: 1,
          updatedAt: 2,
          occurrences: 3,
          sources: ["quality-gate"],
          violation: 5,
          suppressed: 3,
          recurrences: 0,
          evidence: [],
          origin: "threshold",
        },
      ]).persisted();
      assert.ok(card);
      assert.equal(card.samples, 0);
      assert.equal(card.violation, 5);
      assert.equal(card.suppressed, 3);
    });

    it("会话收尾：armed 同项目规则 samples+1，其它项目规则不动；无 pass 不增 observed", async () => {
      const store = makeStore();
      const aReceipt = await store.report(rawRec({ signature: "k-a" }) as never);
      const a = aReceipt.candidate!.id;
      const bReceipt = await store.report(rawRec({ signature: "k-b", project: "other" }) as never);
      const otherId = bReceipt.candidate!.id;
      await store.ruleAction(a, "arm");
      await store.ruleAction(otherId, "arm");
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set());
      assert.equal(ruleById(store, a)?.samples, 1, "同项目 armed 规则记一次暴露");
      assert.equal(ruleById(store, otherId)?.samples, 0, "其它项目规则不受影响");
      assert.equal(ruleById(store, a)?.suppressed, 0, "无 pass → 不记 observed");
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set(), new Set([a]));
      assert.equal(ruleById(store, a)?.samples, 2, "暴露度继续累加");
      assert.equal(ruleById(store, a)?.suppressed, 1, "被 pass 才记 observed");
    });

    it("本会话违规的规则：既不记 samples 也不记 observed", async () => {
      const store = makeStore();
      const xReceipt = await store.report(rawRec({ signature: "k-x" }) as never);
      const a = xReceipt.candidate!.id;
      await store.ruleAction(a, "arm");
      await store.sessionEnded(PROJECT_KEY_FIXTURE, new Set([a]), new Set([a]));
      assert.equal(ruleById(store, a)?.samples, 0);
      assert.equal(ruleById(store, a)?.suppressed, 0);
    });
  });

  // ── 跨进程共享同一规则库（常驻 web 实例 + CLI 临时会话是常态用法）────────────
  // 每个 dsh 进程各持一个 LessonStore，规则库存设置命名空间 `lesson-loop`（= 条目 id）的
  // provider 对 rules 这个数组键是**整片覆盖**（mergeLayers 不合并数组），于是"看不见
  // 别人写的卡"与"把别人写的卡抹掉"是同一个缺陷的两面——此前真机复现过。下面这些不
  // 变式全部落在 RulesRepository 的读面（cards + revision + usable）与写回执上，不再
  // 依赖真文件：两个 store 各持一份端口、同一份 provider 文档 == 两个进程。
  describe("跨进程共享规则库（端口侧不变式）", () => {
    it("另一进程写入的卡，本进程下一次读取要看得见（映射 1）", async () => {
      const cli = makeStore();
      await cli.report(rawRec({ signature: "cmd-a" }) as never);
      // "另一进程"追加一张：读面因此拿到更高 revision + 含他人新卡
      const revisionBefore = facet.revision();
      facet.setExternally([...facet.persisted(), cardOf({ id: "peer", signature: "cmd-peer" })]);
      assert.equal(facet.revision() > revisionBefore, true, "外部写入必须推进 revision");
      const web = makeStore();
      assert.deepEqual(
        signaturesOf(web.rules()),
        ["cmd-a", "cmd-peer"],
        "常驻进程要看见 CLI 刚写的卡",
      );
      // 本进程随后写一次：写回的是"这一刻"读到的数组，不是任何陈旧副本
      await web.report(rawRec({ signature: "cmd-web" }) as never);
      assert.deepEqual(persistedSigsOf(facet), ["cmd-a", "cmd-peer", "cmd-web"]);
    });

    it("两进程交替报告不互相抹卡（映射 2）", async () => {
      const facetA = makeRulesFacet();
      // 两个进程各持一份端口实例，指向同一份 settings 文档（真机形态）
      const first = otherProcess(facetA.repo);
      const second = otherProcess(createRulesRepository(facetA.provider));
      await first.report(rawRec({ signature: "cmd-a" }) as never);
      await second.report(rawRec({ signature: "cmd-b" }) as never);
      // A 侧回看：自己的卡 + B 刚写的卡都在
      assert.deepEqual(signaturesOf(first.rules()), ["cmd-a", "cmd-b"]);
      await first.report(rawRec({ signature: "cmd-c" }) as never);
      assert.deepEqual(
        facetA
          .persisted()
          .map((row) => row.signature)
          .toSorted(),
        ["cmd-a", "cmd-b", "cmd-c"],
      );
      // 反向：B 侧也要看见 A 之后写的 cmd-c（不是只剩自己那一张）
      assert.deepEqual(signaturesOf(second.rules()), ["cmd-a", "cmd-b", "cmd-c"]);
    });

    it("外部删除不复活：端口报「确实没有了」就照单接受（映射 3）", async () => {
      const writer = makeStore();
      await writer.report(rawRec({ signature: "cmd-keep" }) as never);
      await writer.report(rawRec({ signature: "cmd-doomed" }) as never);
      const revisionBefore = facet.revision();
      // 用户删掉了两张卡：usable 仍 true、数组为空、revision 更新——这是可信的"没有"
      facet.setExternally([]);
      assert.equal(facet.revision() > revisionBefore, true);
      assert.deepEqual(signaturesOf(writer.rules()), [], "读面必须跟住删除");
      // 删空之后本进程再写：只许带新卡，不许把手里的两张写回去
      await writer.report(rawRec({ signature: "cmd-third" }) as never);
      assert.deepEqual(persistedSigsOf(facet), ["cmd-third"]);
    });

    it("读不懂不等于没有：usable:false 时读面为空且任何写都被拒（映射 4）", async () => {
      const scripted = scriptedRulesRepository({
        reads: [{ usable: false, cards: [], revision: 9 }],
      });
      const store = otherProcess(scripted.repo);
      assert.deepEqual(store.rules(), []);
      const receipt = await store.report(rawRec({ signature: "cmd-blind" }) as never);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.reason, PERSIST_FAILED);
      await store.ruleAction("whatever", "arm");
      await store.runDecay();
      await store.migrateFragmentRules();
      await store.migrateProjectKeys();
      assert.equal(scripted.saves(), 0, "读不懂的这一刻一次都不许写");
      assert.ok(scripted.loads() >= 1, "改动仍走写前重读，只是被拒");
    });

    it("usable:false 时端口就算递来旧数组也不写回（读不懂就不背书）", async () => {
      const stale = cardOf({ id: "stale", signature: "cmd-stale" });
      const scripted = scriptedRulesRepository({
        reads: [{ usable: false, cards: [stale], revision: 4 }],
      });
      const store = otherProcess(scripted.repo);
      const receipt = await store.report(rawRec({ signature: "cmd-new" }) as never);
      assert.equal(receipt.reason, PERSIST_FAILED);
      assert.equal(scripted.saves(), 0);
    });

    it("存量坏数据打回注册时不覆写他人数据（映射 4 的空库覆写面）", async () => {
      const poisoned = "用户手改坏的存量段";
      const provider = makeSettingsProvider({ [SETTINGS_NAMESPACE]: { rules: poisoned } });
      const store = otherProcess(attachRulesRepository(provider));
      assert.deepEqual(store.rules(), []);
      const receipt = await store.report(rawRec({ signature: "cmd-x" }) as never);
      assert.equal(receipt.reason, PERSIST_FAILED);
      const decay = await store.runDecay();
      assert.equal(decay.demoted, 0);
      assert.equal(provider.writesOf(SETTINGS_NAMESPACE), 0, "整段一次都没被写过");
      assert.equal(provider.peek(SETTINGS_NAMESPACE)?.["rules"], poisoned, "坏内容保持原样等人修");
    });
  });

  // ── 坏存量的点名时机：第一次"真看得见那一行"时，而不是装载那一刻 ──────────────
  // 0.1.7 的 describe() 只收 ACTIVE fiber，而插件 apply 跑在自己变 ACTIVE 之前，所以开机
  // 那一刻"看不见自己的行"是常态（真实宿主隔离实测过）。在装载期报错要么把时序说成"你写坏了
  // 数据"、要么每次开机白刷一行；两种都不肯要。判据因此挪进 load()：行不在→静默按不可用处理，
  // 行在且 rules 非数组→报一次，修好后重新武装（再坏还要再报）。
  describe("规则库端口的坏存量点名（load 侧一次性）", () => {
    it("条目尚未被投影 ⇒ unusable 但不出声", () => {
      const spy = captureErrors();
      const { cas } = surface(() => []);
      const repository = createRulesRepository(cas);
      assert.equal(repository.load().usable, false);
      assert.equal(spy.count(), 0, "看不见自己的行是装载次序，不是故障");
      spy.restore();
    });

    it("行在、rules 是非数组 ⇒ 报一次 rejected，重复 load 不刷屏", () => {
      const spy = captureErrors();
      const { cas } = surface(() => [
        { ns: SETTINGS_NAMESPACE, value: { rules: [] }, user: { rules: "nope" }, revision: 0 },
      ]);
      const repository = createRulesRepository(cas);
      assert.equal(repository.load().usable, false);
      assert.equal(repository.load().usable, false);
      assert.equal(repository.load().usable, false);
      assert.equal(spy.count(), 1, "同一趟坏形状只点一次名");
      assert.match(spy.text(), /rules namespace rejected/u);
      assert.match(spy.text(), /is not an array/u);
      spy.restore();
    });

    it("修好之后重新武装：坏→好→再坏，报两次", () => {
      const spy = captureErrors();
      let user: Record<string, unknown> = { rules: "nope" };
      const { cas } = surface(() => [
        { ns: SETTINGS_NAMESPACE, value: { rules: [] }, user, revision: 0 },
      ]);
      const repository = createRulesRepository(cas);
      assert.equal(repository.load().usable, false);
      user = { rules: [] };
      assert.equal(repository.load().usable, true, "改回数组即放行（热加载，不必重启）");
      user = { rules: 42 };
      assert.equal(repository.load().usable, false);
      assert.equal(spy.count(), 2, "坏→好→坏：闩在读得懂那次重新武装，第二次坏还要报");
      spy.restore();
    });
  });
});

// rule-signature：规则卡的**键**这一层——签名归一、类别级稳定签名、路径形态识别、归并键拼接。
//
// 为什么从 lib/lesson-store.ts 拆出来：这四件事共同回答「这条教训该并到哪张卡上」。写入侧
// （report / addCandidate）、查找侧（pass / findByKey）、迁移侧（migrateFragmentRules /
// mergeProjectKeyCollisions）与正文起草（lib/statement-draft.ts 按稳定签名选模板）必须算出
// **同一个串**——一处漏调就长成"写得进、查不到"的键漂移，这正是碎片化缺陷的成因。判据与
// store 的度量/落盘纪律无关，故独立成模块；此前它们的 export 只因单测按这层边界取用，
// `fallow --production` 把整层判成「只被测试养着的导出」。
//
// 旧版 factgate-deny 的 signature 是「编辑目标路径」→ 同一条通用教训（编辑前
// 先取证）按文件被拆成几十张互不相通的碎片卡，armed 后其它文件的同类拒绝也
// 永不命中（ruleKey 精确匹配）→ 度量环节对最重要的规则失效。改为类别级稳定
// 键：同一类教训汇聚成一张规则卡，armed 规则按类别命中，violation/suppressed
// 恢复有效。目标路径信息移入 evidence.signature，不丢。

/** 归档汇总签名的固定后缀（`${稳定签名}:rejected`）：lesson-store 的 rejected 碎片
 *  归并与本包的正文起草两侧共用，避免两侧各自硬编码后漂移。 */
export const REJECTED_SUMMARY_SUFFIX = ":rejected";

/** 归一签名里出现的非字符串（缺字段/类型漂移）：留一条日志，否则多个缺失签名
 *  会被拼成完全相同的键、悄悄归并成同一张卡。 */
function warnNonStringSignature(value: unknown): void {
  console.warn(
    `[lesson-loop] lesson signature is not a string (${typeof value}); treating as empty`,
  );
}

/** 规则归并键。签名归一：trim + 内部空白折叠（大小写保留——路径/命令大小写有意）。 */
export function normalizeSignature(signature: unknown): string {
  if (typeof signature !== "string") {
    warnNonStringSignature(signature);
    return "";
  }
  return signature.trim().replaceAll(/\s+/gu, " ");
}

export const CATEGORY_SIGNATURES: Readonly<Record<string, string>> = Object.freeze({
  "factgate-deny": "edit-before-factgate",
  // 密钥路径与 factgate 同类：一张卡代表"这类文件不要碰"，具体是哪个 .env 落在
  // 证据里。旧形态下每个凭据文件一张 occurrences=1 的卡，永远够不到升格门槛。
  "secret-path": "edit-before-secret-path",
  // 危险 shell 形态同理，且此处**两件事**一起收：① 每条不同命令各开一张碎片卡
  // （occurrences=1，够不到升格门槛）；② "认不准"那一类（`bash-nested-shell-unconfirmed`）
  // 的签名是常量、命令原文原先根本没进证据，卡片里只有一段逐字相同的模板文，人审时
  // 看不出该审什么。折叠到类别级稳定键后，**命令原文落进 evidence.signature**
  // （见 lesson-store 的 evidenceRow：raw ≠ folded 才写该键），一张卡既收敛又可审。
  "dangerous-bash": "dangerous-bash",
});

/** 查表用 Map：Object 字面量的索引会带出原型链上的同名成员（`toString`/
 *  `constructor` 当 category 时拿到的是函数），Map 没有这个洞。 */
const STABLE_SIGNATURES: ReadonlyMap<string, string> = new Map(Object.entries(CATEGORY_SIGNATURES));

/** 该 (category, signature) 是否就是这一类的稳定签名（正文起草按它选通用模板）。 */
export function isStableSignature(category: string, signature: string): boolean {
  return STABLE_SIGNATURES.get(category) === signature;
}

/** 该 (category, signature) 是否是这一类的 rejected 归档汇总签名。 */
export function isRejectedSummarySignature(category: string, signature: string): boolean {
  const stable = STABLE_SIGNATURES.get(category);
  return stable !== undefined && signature === `${stable}${REJECTED_SUMMARY_SUFFIX}`;
}

/**
 * 签名归一（写入侧唯一入口）：登记表内的类别一律折叠到类别级稳定签名，表外类别
 * 保留自身签名（行为与折叠前逐字节相同）。幂等——稳定签名再查一次仍是自身，
 * 所以存量卡与新建卡走同一个键。report()/pass()/addCandidate() 与卡片查找必须
 * 全部经这里，任何一处漏调都会造成"写得进、查不到"的键漂移。
 */
export function stableSignatureFor(category: string, signature: unknown): string {
  const normalized = normalizeSignature(signature);
  return STABLE_SIGNATURES.get(category) ?? normalized;
}

/** 路径/文件名形态签名判定（迁移归并的识别器，factgate / secret-path 的碎片是文件路径）。 */
export function looksLikePathSignature(signature: string): boolean {
  return (
    signature.includes("/") ||
    signature.includes("\\") ||
    /\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|java|kt|swift|vue|svelte|json|ya?ml|css|scss|html|md|sh|sql|toml|c|cpp|h|hpp|lock)$/iu.test(
      signature,
    )
  );
}

/** 碎片判据**不看路径形态**的类别：它们的碎片签名是命令原文（详见 isFragmentSignatureOf）。 */
const ANY_SIGNATURE_FRAGMENTS: ReadonlySet<string> = new Set(["dangerous-bash"]);

/**
 * 某类别的一张卡是不是"待归并的碎片"。默认 = 路径型签名（factgate / secret-path 的碎片是
 * 文件路径）；dangerous-bash 例外：它的碎片是**命令原文**（`git commit --no-verify` 这类既
 * 无斜杠也无扩展名），路径判据只偶然命中（`curl https://… | sh` 里的那个斜杠），照它筛会把
 * 大多数存量碎片留在库外——而写入侧早已把命令一律折到类别级稳定签名，这些旧卡既不再增长、
 * 也永远命中不了度量，只会一直占着列表。非稳定签名的卡即碎片；稳定签名自身（以及 rejected
 * 归档汇总签名）在这里就返回 false，调用方不必再各自加前置判断——判据长在函数里，"已收敛
 * 的稳定卡被当碎片反复归并"这类迁移不收敛才真正结构性堵死。
 */
export function isFragmentSignatureOf(category: string, signature: string): boolean {
  if (isStableSignature(category, signature) || isRejectedSummarySignature(category, signature)) {
    return false;
  }
  return ANY_SIGNATURE_FRAGMENTS.has(category) || looksLikePathSignature(signature);
}

/**
 * 归并键拼接。**前置条件：调用方已先经 stableSignatureFor 折叠**（report / pass /
 * addCandidate 都满足），本函数刻意不在内部折叠——rejected 归档汇总签名
 * `${stable}:rejected` 若在这里再查一次表会原样退回（表外值保留自身），于是汇总卡与
 * armed 稳定卡撞成同一个键，人工拒绝记录会被活卡吞掉。
 */
export function ruleKey(project: string, category: string, signature: string): string {
  return `${project}\u0000${category}\u0000${normalizeSignature(signature)}`;
}

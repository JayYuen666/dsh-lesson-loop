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

/** 规则归并键。签名归一：trim + 内部空白折叠（大小写保留——路径/命令大小写有意）。 */
export function normalizeSignature(signature: unknown): string {
  if (typeof signature !== "string") {
    return "";
  }
  return signature.trim().replaceAll(/\s+/gu, " ");
}

export const CATEGORY_SIGNATURES: Record<string, string> = {
  "factgate-deny": "edit-before-factgate",
  // 密钥路径与 factgate 同类：一张卡代表"这类文件不要碰"，具体是哪个 .env 落在
  // 证据里。旧形态下每个凭据文件一张 occurrences=1 的卡，永远够不到升格门槛。
  "secret-path": "edit-before-secret-path",
};

/** 查表用 Map：Object 字面量的索引会带出原型链上的同名成员（`toString`/
 *  `constructor` 当 category 时拿到的是函数），Map 没有这个洞。 */
const STABLE_SIGNATURES: ReadonlyMap<string, string> = new Map(Object.entries(CATEGORY_SIGNATURES));

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

/** 路径/文件名形态签名判定（迁移归并的识别器）。 */
export function looksLikePathSignature(signature: string): boolean {
  return (
    signature.includes("/") ||
    signature.includes("\\") ||
    /^\.{1,2}[/\\]/u.test(signature) ||
    /\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|java|kt|swift|vue|svelte|json|ya?ml|css|scss|html|md|sh|sql|toml|c|cpp|h|hpp|lock)$/iu.test(
      signature,
    )
  );
}

export function ruleKey(project: string, category: string, signature: string): string {
  return `${project}\u0000${category}\u0000${normalizeSignature(signature)}`;
}

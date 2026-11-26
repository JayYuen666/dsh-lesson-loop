// src/rules-reader.ts —— 设置卡读写**宿主侧规则评审**的入口（官方 Typert Remote 的消费端）。
//
// 为什么需要它：卡片跑在浏览器里，而规则库、事件流水与人工动作都在宿主进程。设置面没有
// 「宿主执行动作」的口子，唯一的官方通道就是 Remote（见 lib/rules-remote.ts 的文件头）。
//
// 为什么 descriptor 是**手写**的：宿主网关在源模式（SRC）下从方法签名推参数名，参数与
// 结果都走 `{ mode: "src-json" }`，不需要生成器的 `typeSymbol` / `create()` 产物。但**客户端**
// 的贡献校验（`$mount` → `requireStrictCodec`）要求每个入参都带 strict codec，非 strict 会
// 拒绝整份贡献。于是这里的入参 codec 写成 strict 的 zod schema：它只在客户端做形状校验，
// 从不跨网；宿主那边仍按源模式从签名取参数名。
//
// ⚠ **为什么走 `ctx.get("remote")` 而不是把 `remote` 写进 `inject`**：cordis 对**未 inject 的
// 服务**读取是**抛错**。而本卡的其余部分在"没装远程通道"的部署里也必须照常渲染（远程读取接口是
// 可选能力），`inject: ["remote", …]` 却会把整条 client 入口绑死在远程通道上——缺它就不激活。
// `ctx.get` 是**显式读取**，不受 inject 门禁约束——官方网关自己也是这么读可选服务的。
//
// ⚠ 类型一律 `import type`：`@deepseek-ai/*` 只作类型消费，产物里不新增模块说明符。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/client";
// 值导入与类型导入合并成一条（inline type specifier）：TS 7.0.2 在本文件把
// 「同模块的分立 value import + import type」解析成 TS2307（trace 里成功、检查器仍丢绑定，
// rtk 同款形态无恙，唯本文件触发）；import/consistent-type-specifier-style 要求分立，
// 两条规则互斥，此处定向豁免 lint 一侧并留档。
import {
  isRemoteMounter,
  type RemoteHost,
  type RemoteMounter,
} from "@jayyuen66/dsh-plugin-shared/lib/typert-client";
import { z } from "zod";

import { RULES_BUNDLE_PACKAGE, RULES_REMOTE_NAMESPACE } from "../lib/rules-shape.ts";
import type {
  LessonsRequest,
  LessonsResult,
  RuleDetailReplyOrFailure,
  RuleDetailRequest,
  RuleActionReply,
  RuleActionRequest,
  RulesRequest,
  RulesResult,
} from "../lib/rules-shape.ts";

/** 客户端上下文里本模块用到的那一位：**显式读取**一个可选服务（见文件头为什么不用
 *  inject）。正主在 shared `./lib/typert-client`（含 isRemoteMounter，七份逐字副本收编）。
 *  再导出放在 import 块之后：夹在中间会让后续 import 被判「不在文件顶部」。 */
export type { RemoteHost } from "@jayyuen66/dsh-plugin-shared/lib/typert-client";

/** 网关给命名空间注册的**服务键**：`remote.<namespace>`。它在 `$mount` 完成之后才存在，
 *  所以只能在挂载后按这个键去读，而不是提前 inject。 */
const RULES_SERVICE_KEY = `remote.${RULES_REMOTE_NAMESPACE}`;

/** 卡片所在 bundle 的包名（`$mount` 的 `package` 位与槽位键同源）：唯一来源在 lib/rules-shape.ts，
 *  client-entry 的 BUNDLE_PKG 与这里都从它取——字面量只有一份。 */
const PACKAGE_NAME = RULES_BUNDLE_PACKAGE;

/** strict codec 的统一出口：失败交给 zod 的 `prettifyError`，读到的是一份带字段路径的说明。 */
function parseOrThrow<Result>(schema: z.ZodType<Result>, value: unknown): Result {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

const RULES_PROJECT_MESSAGE = "rules request project must be a string";
const RULES_SCHEMA = z.object(
  { project: z.string({ error: RULES_PROJECT_MESSAGE }).optional() },
  { error: "rules request must be an object" },
);

const LESSONS_PROJECT_MESSAGE = "lessons request project must be a string";
// NaN/Infinity/负数不该被当成"合法请求"放给宿主——宿主对非有限与 ≤0 一律取
// 默认条数，非法值静默降级成一次正常请求会让调用方看不出自己传错了。0 是
// 有语义的显式形态（与缺省同走默认条数），放行。
const LESSONS_LIMIT_MESSAGE = "lessons request limit must be a non-negative finite number";
const LESSONS_SCHEMA = z.object(
  {
    project: z.string({ error: LESSONS_PROJECT_MESSAGE }).optional(),
    limit: z
      .number({ error: LESSONS_LIMIT_MESSAGE })
      .refine((value) => Number.isFinite(value) && value >= 0, {
        error: LESSONS_LIMIT_MESSAGE,
      })
      .optional(),
  },
  { error: "lessons request must be an object" },
);

const RULE_ACTION_MESSAGE = "rule-action request requires string id and action";
const RULE_ACTION_SCHEMA = z.object(
  {
    id: z.string({ error: RULE_ACTION_MESSAGE }),
    action: z.string({ error: RULE_ACTION_MESSAGE }),
    statement: z.string({ error: "rule-action request statement must be a string" }).optional(),
  },
  { error: "rule-action request must be an object" },
);

const RULE_DETAIL_ID_MESSAGE = "rule-detail request requires a string id";
const RULE_DETAIL_OBJECT_MESSAGE = "rule-detail request must be an object";
const RULE_DETAIL_CURSOR_MESSAGE =
  "rule-detail request cursor must be a non-negative integer when present";
const RULE_DETAIL_SCHEMA = z.object(
  {
    id: z.string({ error: RULE_DETAIL_ID_MESSAGE }),
    cursor: z
      .number({ error: RULE_DETAIL_CURSOR_MESSAGE })
      .refine((value) => Number.isInteger(value) && value >= 0, {
        error: RULE_DETAIL_CURSOR_MESSAGE,
      })
      .optional(),
  },
  { error: RULE_DETAIL_OBJECT_MESSAGE },
);

/** 证据分页请求的客户端 parser。 */
const RULE_DETAIL_CODEC: TypertCodec<RuleDetailRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#rule-detail-request`,
  create: () => ({
    parse(value: unknown): RuleDetailRequest {
      const request = parseOrThrow(RULE_DETAIL_SCHEMA, value);
      return request.cursor === undefined
        ? { id: request.id }
        : { id: request.id, cursor: request.cursor };
    },
  }),
};

/** 规则列表请求的客户端 parser：只核本方法真正读的那一位（`project` 是串或缺失）。 */
const RULES_CODEC: TypertCodec<RulesRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#rules-request`,
  create: () => ({
    parse(value: unknown): RulesRequest {
      const request = parseOrThrow(RULES_SCHEMA, value);
      return request.project === undefined ? {} : { project: request.project };
    },
  }),
};

/** 事件流水请求的客户端 parser（同上；`limit` 是数或缺失）。 */
const LESSONS_CODEC: TypertCodec<LessonsRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#lessons-request`,
  create: () => ({
    parse(value: unknown): LessonsRequest {
      const request = parseOrThrow(LESSONS_SCHEMA, value);
      return {
        ...(request.project === undefined ? {} : { project: request.project }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      };
    },
  }),
};

/** 人工动作请求的客户端 parser（`id` / `action` 必填，`statement` 可选）。 */
const RULE_ACTION_CODEC: TypertCodec<RuleActionRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#rule-action-request`,
  create: () => ({
    parse(value: unknown): RuleActionRequest {
      const request = parseOrThrow(RULE_ACTION_SCHEMA, value);
      return request.statement === undefined
        ? { id: request.id, action: request.action }
        : { id: request.id, action: request.action, statement: request.statement };
    },
  }),
};

/** 把宿主那组方法挂到客户端远程通道上的描述符（`id` 的形状照生成器：`<包>#<命名空间>/<方法>`）。
 *  导出它只为一件事：`test/rules-remote.test.ts` 拿它与宿主侧 `remoteMethods()` 的标记对质
 *  —— 两侧分叉时卡片不会报错，只会"读不到"，所以那条比较必须在门禁里。 */
export const RULES_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${RULES_REMOTE_NAMESPACE}/stats`,
    service: RULES_REMOTE_NAMESPACE,
    namespace: RULES_REMOTE_NAMESPACE,
    method: "stats",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RULES_REMOTE_NAMESPACE}/rules`,
    service: RULES_REMOTE_NAMESPACE,
    namespace: RULES_REMOTE_NAMESPACE,
    method: "rules",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: RULES_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RULES_REMOTE_NAMESPACE}/lessons`,
    service: RULES_REMOTE_NAMESPACE,
    namespace: RULES_REMOTE_NAMESPACE,
    method: "lessons",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: LESSONS_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RULES_REMOTE_NAMESPACE}/ruleDetail`,
    service: RULES_REMOTE_NAMESPACE,
    namespace: RULES_REMOTE_NAMESPACE,
    method: "ruleDetail",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: RULE_DETAIL_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RULES_REMOTE_NAMESPACE}/ruleAction`,
    service: RULES_REMOTE_NAMESPACE,
    namespace: RULES_REMOTE_NAMESPACE,
    method: "ruleAction",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: RULE_ACTION_CODEC }],
    result: { mode: "src-json" },
  },
];

/** 挂载后由网关提供的命名空间宿主服务。方法名在此文件里有**四份手写副本**：本接口、
 *  isRulesNamespace 的逐名守卫、RULES_DESCRIPTORS 的 method 位、以及 createRulesReader
 *  返回类型里的 ns.xxx() 调用——任何一份与宿主实际方法名分叉，先红的是 descriptor 对质
 *  那条测试（test/rules-remote.test.ts），改方法名时四处一起动。 */
interface RulesNamespace {
  stats: () => Promise<RemoteResult<Record<string, unknown>>>;
  rules: (request: RulesRequest) => Promise<RemoteResult<RulesResult>>;
  lessons: (request: LessonsRequest) => Promise<RemoteResult<LessonsResult>>;
  ruleAction: (request: RuleActionRequest) => Promise<RemoteResult<RuleActionReply>>;
  ruleDetail: (request: RuleDetailRequest) => Promise<RemoteResult<RuleDetailReplyOrFailure>>;
}

/**
 * 卡片用到的读取器。`stats` 交回原始记录（卡片那层逐字段守卫照旧生效）；拒绝回执原样
 * 交回，由卡片决定怎么显示——传输/网关失败才抛。
 *
 * `ruleDetail` 是**唯一带两支**的读方法：宿主的 400/404/500 是以数据形式回执
 * （`{ ok: false, error, status }`）而不是网关层失败，`unwrapRemote` 只认后者，
 * 所以这里必须把联合类型一路交到卡片，由它按 `ok` 分流——收窄成 `RuleDetailReply`
 * 会让失败回执被当成成功回执读，`evidence` 变成 undefined，渲染期炸在 `entries.length`。
 */
export interface RulesReader {
  stats: () => Promise<Record<string, unknown>>;
  rules: (request?: RulesRequest) => Promise<RulesResult>;
  lessons: (request?: LessonsRequest) => Promise<LessonsResult>;
  ruleAction: (id: string, action: string, statement?: string) => Promise<RuleActionReply>;
  ruleDetail: (id: string, cursor?: number) => Promise<RuleDetailReplyOrFailure>;
}

/** 网关拒绝回执 → 抛错（每个读取方法同一段判据，抽出来保证规则一致：错误前缀
 *  `code: message` 不许某一处悄悄变体）。 */
function unwrapRemote<Value>(result: RemoteResult<Value>): Value {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** 命名空间必须提供的全部方法名（diagnostic 与守卫同源，免得两处各写一份）。 */
const RULES_NAMESPACE_METHODS = [
  "stats",
  "rules",
  "lessons",
  "ruleAction",
  "ruleDetail",
] as const satisfies readonly (keyof RulesNamespace)[];

/** 同上：命名空间服务（挂载之后才有，缺它说明网关没认这枚贡献）。
 *
 *  **五个方法一个都不能少**：本包的宿主半与客户端半同一个 bundle 发布，两者对外方法集
 *  恒等（test/rules-remote.test.ts 拿 RULES_DESCRIPTORS 与宿主 remoteMethods() 对质）。
 *  把某一枚放宽成可选，等于给"宿主还是上一版、客户端已升"这个窗口造一条静默降级路径
 *  ——那一格里 stats/rules/lessons 全都还在，只有新的那枚缺席，读面却会被整体判成"没提供"，
 *  更糟的是有人会把这条放宽读成"兼容旧宿主"，于是新方法的失败从此没人负责。 */
const isRulesNamespace = (value: unknown): value is RulesNamespace =>
  isRecord(value) && RULES_NAMESPACE_METHODS.every((name) => typeof value[name] === "function");

/** 缺哪些方法——只进错误文案，不参与类型收窄。 */
function missingNamespaceMethods(value: unknown): string {
  if (!isRecord(value)) {
    return "（不是对象）";
  }
  const missing = RULES_NAMESPACE_METHODS.filter((name) => typeof value[name] !== "function");
  return missing.length === 0 ? "（齐全）" : missing.join(", ");
}

/**
 * 造出真正的读取器（挂载一次 + 每次读命名空间服务）。
 * @param ctx - 客户端上下文
 * @param remote - 已核过形状的远程通道
 * @returns 读取器
 */
function buildRulesReader(ctx: RemoteHost, remote: RemoteMounter): RulesReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<RulesNamespace> => {
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: RULES_DESCRIPTORS });
    // 挂载失败**不缓存**：网关的 $mount 走 ctx.effect + enqueue，失败是可恢复的（版本不匹配、
    // 贡献注册时序未到、网关重连）。把 rejected 的 promise 留在 mounted 上，会把一次可恢复失败
    // 钉成该卡片生命周期内的永久不可用 —— 之后每次读取都复读同一次拒绝，连网关都不再问。
    try {
      await mounted;
    } catch (error) {
      mounted = undefined;
      throw error;
    }
    const namespace = ctx.get?.(RULES_SERVICE_KEY, false);
    if (!isRulesNamespace(namespace)) {
      // 点名缺哪几枚：只说"未提供"时，"网关没挂上"与"挂了但是旧版少一枚方法"长得一模一样。
      throw new Error(
        `${RULES_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间（缺 ${missingNamespaceMethods(namespace)}）`,
      );
    }
    return namespace;
  };
  return {
    async stats(): Promise<Record<string, unknown>> {
      const ns = await namespaceOf();
      const result = await ns.stats();
      return unwrapRemote(result);
    },
    async rules(request: RulesRequest = {}): Promise<RulesResult> {
      const ns = await namespaceOf();
      const result = await ns.rules(request);
      return unwrapRemote(result);
    },
    async lessons(request: LessonsRequest = {}): Promise<LessonsResult> {
      const ns = await namespaceOf();
      const result = await ns.lessons(request);
      return unwrapRemote(result);
    },
    async ruleDetail(id: string, cursor?: number): Promise<RuleDetailReplyOrFailure> {
      const ns = await namespaceOf();
      const result = await ns.ruleDetail(cursor === undefined ? { id } : { id, cursor });
      return unwrapRemote(result);
    },
    async ruleAction(id: string, action: string, statement?: string): Promise<RuleActionReply> {
      const ns = await namespaceOf();
      const result = await ns.ruleAction(
        statement === undefined ? { id, action } : { id, action, statement },
      );
      return unwrapRemote(result);
    },
  };
}

/**
 * 造一个「读/写宿主侧规则评审」的读取器；**当前部署没有远程通道时返回 `undefined`**
 * （卡片照常渲染，只是数据那一栏显示读不到 —— 与 host 侧可选读取接口同一条规则）。
 *
 * `$mount` 是**幂等**的（挂进本 fiber，随卡片卸载自动撤），所以这里缓存那枚 promise：
 * 同一次会话里反复拉取只挂一次。
 *
 * @param ctx - 客户端上下文（只用 `get` 一位）
 * @returns 读取器；没有远程通道时 `undefined`
 */
export function createRulesReader(ctx: RemoteHost): RulesReader | undefined {
  const remote = ctx.get?.("remote");
  // 单 return（三元的另一支是 `undefined`）：`consistent-return` 不接受"早退 undefined + 晚退函数"
  // 这种混合形状，而这里两种结果本来就是同一件事的两头。
  return isRemoteMounter(remote) ? buildRulesReader(ctx, remote) : undefined;
}

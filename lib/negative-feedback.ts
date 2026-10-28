// negative-feedback：从**会话事件流**里投影出人工差评（feedback 三事件的当前态折叠）。
//
// 为什么从 lib/digest.ts 拆出来：这一段回答"人对本会话说了哪些不满"，输入是官方判别联合的
// 事件流、输出是结构化的差评条目，与"把这些条目拼成蒸馏帧"（lib/digest-prompt.ts）和"跑一次
// 蒸馏"（lib/digest.ts 的 runDigest）是三件事。拆出来之后 collectNegativeFeedback 有真实生产
// 消费者（runDigest），它的 export 不再是"只被测试养着"的那一面。
//
// packages/feedback 刻意不进模型上下文，这里是它的唯一出口（经用户手动命令触发）：差评正文
// 全量保留，不截断；已撤回/改成好评的槽位一律不算负面信号。

// 从对象安全读字段：字面量键走变量参数，绕开 dot-notation 与
// noPropertyAccessFromIndexSignature 的互斥。
import { fieldOf } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 一条人工差评（kind 区分消息差评与会话备注）。 */
export interface NegativeFeedback {
  messageId?: string;
  note: string;
  category?: string;
  kind: "message" | "session";
}

/** 差评正文归一：缺省（字段不在）退空串；类型漂移（在但不是字符串）退原始载荷的
 *  可读序列化——人工输入不许凭空消失成一条空 note。对象/数组的 JSON 序列化必须兜底：
 *  循环引用、内嵌 BigInt、自带抛错的 toJSON 都会让 stringify 直接抛 TypeError，而本
 *  函数的立身之本是"人工输入不许凭空消失"——整条投影不能因为这些漂移载荷炸掉。 */
function noteText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    // 标量漂移取 String 原文（含 symbol/function/bigint 这类 JSON 往返造不出的形态）。
    return String(value);
  }
  // 剩余形态就是对象/数组，JSON 原文可读。toJSON 返回 undefined 时 stringify 的
  // **运行时**返回值是 undefined（类型面看不出这条，所以不用 ?? 判空而是按类型收窄）；
  // 循环引用/内嵌 BigInt 走 catch，退最后的辨认形态。
  try {
    const text: string = JSON.stringify(value);
    return typeof text === "string" ? text : Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** 事件槽位：feedback 可被后续 put 原位替换；undefined = 已撤回/改好评（槽位保留以维持顺序）。 */
interface FeedbackSlot {
  feedback: NegativeFeedback | undefined;
}

/** 差评槽位台账：ordered 定输出顺序，keyed 让同一条消息的多次 put/delete 落在同一槽位。 */
interface SlotLedger {
  readonly ordered: FeedbackSlot[];
  readonly keyed: Map<string, FeedbackSlot>;
}

/** 消息差评投影：put 载荷即改后的完整当前值，字段漂移按空串/可读序列化归一。 */
function messageFeedback(item: unknown): NegativeFeedback {
  const messageId = fieldOf(item, "messageId");
  const note = fieldOf(item, "note");
  const category = fieldOf(item, "category");
  return {
    ...(typeof messageId === "string" ? { messageId } : {}),
    note: noteText(note),
    ...(typeof category === "string" ? { category } : {}),
    kind: "message",
  };
}

/** 占用（或复用）某个键的槽位；新槽位按出现顺序追加。 */
function slotFor(ledger: SlotLedger, key: string): FeedbackSlot {
  const existing = ledger.keyed.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const slot: FeedbackSlot = { feedback: undefined };
  ledger.keyed.set(key, slot);
  ledger.ordered.push(slot);
  return slot;
}

/** 无业务键条目的内容指纹：同一载荷重复回放折进同一槽位，不再放大成多条。
 *  键用 JSON 序列化拼装而不是分隔符连接：note / category 是上报方可控的自由文本，
 *  含 `\u0000` 时 `("a\u0000b","c")` 与 `("a","b\u0000c")` 会拼出同一个键，两条不同的
 *  坏事件被折成一条。 */
function fingerprintKey(scope: string, note: string, category: string | undefined): string {
  return JSON.stringify([scope, note, category ?? ""]);
}

/** 业务键（messageId）的槽位键：加固定前缀与内容指纹共用一张 keyed 表——裸 messageId
 *  恰好长成某条指纹的形状时（`["anon",…]` 一类），message-delete 会撤到别人的槽位上。 */
function businessKey(messageId: string): string {
  return `id\u0000${messageId}`;
}

/**
 * feedback/message-put：create-or-edit，按 rating 三分。
 *   negative → 落差评；positive → 撤回；其余（rating 缺失/漂移成未知值）→ 原样不动。
 * 只认显式好评当撤销：载荷漂移不许把已存在的真实差评静默清空。
 */
function applyMessagePut(data: unknown, ledger: SlotLedger, rating: unknown): void {
  const item = fieldOf(data, "item");
  const messageId = fieldOf(item, "messageId");
  if (rating === "negative") {
    if (typeof messageId === "string") {
      slotFor(ledger, businessKey(messageId)).feedback = messageFeedback(item);
      return;
    }
    // 无 id 的坏事件：按内容指纹落槽，重复回放同一条载荷不会变成多条（宁可多留
    // 一条背景，不静默丢人工输入）。代价明说：message-delete 拿业务键撤不到它——
    // 无 id 载荷没有可折叠的撤回键，这条差评只能被下面的"同载荷改好评"清掉。
    const feedback = messageFeedback(item);
    slotFor(ledger, fingerprintKey("anon", feedback.note, feedback.category)).feedback = feedback;
    return;
  }
  if (rating !== "positive") {
    return;
  }
  if (typeof messageId === "string") {
    const slot = ledger.keyed.get(businessKey(messageId));
    if (slot !== undefined) {
      slot.feedback = undefined;
    }
    return;
  }
  // 无 id 的好评：同一载荷先前若按内容指纹落过槽（无 id 的差评被改成好评且载荷原样），
  // 按同一指纹清槽——"从不是差评的条目"不该永久留在蒸馏背景里。正文被一并改掉时指纹
  // 对不上，清不到：与有 id 路径的语义一致，撤回按键（有 id）或按内容（无 id）。
  const feedback = messageFeedback(item);
  const slot = ledger.keyed.get(fingerprintKey("anon", feedback.note, feedback.category));
  if (slot !== undefined) {
    slot.feedback = undefined;
  }
}

/** feedback/message-delete：撤回一条差评（未记账过的 messageId 与无 id 都无害）。 */
function applyMessageDelete(data: unknown, ledger: SlotLedger): void {
  const messageId = fieldOf(data, "messageId");
  if (typeof messageId !== "string") {
    return;
  }
  const slot = ledger.keyed.get(businessKey(messageId));
  if (slot !== undefined) {
    slot.feedback = undefined;
  }
}

/** feedback/record：会话级备注（无 rating 语义也无撤回面，人工提交原文全量纳入）。
 *  同样没有业务键：按内容指纹落槽，同一备注重复提交/事件重复回放只记一条——
 *  重复输入不该放大它在蒸馏提示里的权重。 */
function appendSessionRecord(data: unknown, ledger: SlotLedger): void {
  const text = fieldOf(data, "text");
  const category = fieldOf(data, "category");
  const note = noteText(text);
  const catStr = typeof category === "string" ? category : undefined;
  if (note.trim().length === 0 && catStr === undefined) {
    return;
  }
  const feedback: NegativeFeedback = {
    note,
    ...(catStr === undefined ? {} : { category: catStr }),
    kind: "session",
  };
  // 指纹按 trim 后的文本落槽，与上面的空判归一同一口径：只差首尾空白的重复提交
  // （"太慢" 与 " 太慢 "）是同一条备注，不该在蒸馏提示里重复放大权重；
  // 槽里保留的是最新一次提交的原文（输出不 trim）。
  slotFor(ledger, fingerprintKey("record", note.trim(), catStr)).feedback = feedback;
}

/** 单个事件对槽位台账的作用（非对象事件与未知类型都无副作用）。 */
function applyFeedbackEvent(event: unknown, ledger: SlotLedger): void {
  const evType = fieldOf(event, "type");
  const evData = fieldOf(event, "data");
  if (evType === "feedback/message-put") {
    applyMessagePut(evData, ledger, fieldOf(fieldOf(evData, "item"), "rating"));
    return;
  }
  if (evType === "feedback/message-delete") {
    applyMessageDelete(evData, ledger);
    return;
  }
  if (evType === "feedback/record") {
    appendSessionRecord(evData, ledger);
  }
}

/**
 * 从会话事件流收集人工差评（negative 评级 + 会话级备注）。全量保留 note 原文。
 *
 * `feedback/message-put` 是 create-or-edit（载荷即改后的完整当前值），
 * `feedback/message-delete` 是撤回（harness message-feedback/types.ts）。故必须按
 * messageId 折叠到当前态：只追加会把「差评改成好评」「差评已删除」继续当作负面
 * 信号喂给蒸馏模型，蒸馏结果再进规则卡注入到后续每个会话。rating 漂移成未知值时
 * 保守不动现有槽位（既不清空也不覆盖）。
 */
export function collectNegativeFeedback(events: readonly unknown[]): NegativeFeedback[] {
  const ledger: SlotLedger = { ordered: [], keyed: new Map() };
  for (const event of events) {
    applyFeedbackEvent(event, ledger);
  }
  const out: NegativeFeedback[] = [];
  for (const slot of ledger.ordered) {
    const { feedback } = slot;
    if (feedback !== undefined) {
      out.push(feedback);
    }
  }
  return out;
}

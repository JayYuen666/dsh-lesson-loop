// negative-feedback：从**会话事件流**里投影出人工差评（feedback 三事件的当前态折叠）。
//
// 为什么从 lib/digest.ts 拆出来：这一段回答"人对本会话说了哪些不满"，输入是官方判别联合的
// 事件流、输出是结构化的差评条目，与"把这些条目拼成蒸馏帧"（lib/digest-prompt.ts）和"跑一次
// 蒸馏"（lib/digest.ts 的 runDigest）是三件事。拆出来之后 collectNegativeFeedback 有真实生产
// 消费者（runDigest），它的 export 不再是"只被测试养着"的那一面。
//
// packages/feedback 刻意不进模型上下文，这里是它的唯一出口（经用户手动命令触发）：差评正文
// 全量保留，不截断；已撤回/改成好评的槽位一律不算负面信号。

import { fieldOf } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 从对象安全读字段：字面量键走变量参数，绕开 dot-notation 与
 *  noPropertyAccessFromIndexSignature 的互斥。 */
export interface NegativeFeedback {
  messageId?: string;
  note: string;
  category?: string;
  ts?: number;
  kind: "message" | "session";
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

/** 消息差评投影：put 载荷即改后的完整当前值，字段漂移按空串/缺省归一。 */
function messageFeedback(item: unknown): NegativeFeedback {
  const messageId = fieldOf(item, "messageId");
  const note = fieldOf(item, "note");
  const category = fieldOf(item, "category");
  return {
    ...(typeof messageId === "string" ? { messageId } : {}),
    note: typeof note === "string" ? note : "",
    ...(typeof category === "string" ? { category } : {}),
    kind: "message",
  };
}

/** 占用（或复用）某条消息的槽位；新槽位按出现顺序追加。 */
function slotFor(ledger: SlotLedger, messageId: string): FeedbackSlot {
  const existing = ledger.keyed.get(messageId);
  if (existing !== undefined) {
    return existing;
  }
  const slot: FeedbackSlot = { feedback: undefined };
  ledger.keyed.set(messageId, slot);
  ledger.ordered.push(slot);
  return slot;
}

/** feedback/message-put：create-or-edit，按 messageId 折叠到当前态。 */
function applyMessagePut(data: unknown, ledger: SlotLedger, negative: boolean): void {
  const item = fieldOf(data, "item");
  const messageId = fieldOf(item, "messageId");
  if (typeof messageId !== "string") {
    // 无 id 的坏事件：不折叠，按原样保留（宁可多一条背景，不静默丢人工输入）。
    if (negative) {
      ledger.ordered.push({ feedback: messageFeedback(item) });
    }
    return;
  }
  const slot = slotFor(ledger, messageId);
  slot.feedback = negative ? messageFeedback(item) : undefined;
}

/** feedback/message-delete：撤回一条差评（未记账过的 messageId 与无 id 都无害）。 */
function applyMessageDelete(data: unknown, ledger: SlotLedger): void {
  const messageId = fieldOf(data, "messageId");
  if (typeof messageId !== "string") {
    return;
  }
  const slot = ledger.keyed.get(messageId);
  if (slot !== undefined) {
    slot.feedback = undefined;
  }
}

/** feedback/record：会话级备注（无 rating 语义也无撤回面，人工提交原文全量纳入）。 */
function appendSessionRecord(data: unknown, ledger: SlotLedger): void {
  const text = fieldOf(data, "text");
  const category = fieldOf(data, "category");
  const textStr = typeof text === "string" ? text : "";
  const catStr = typeof category === "string" ? category : undefined;
  if (textStr.trim().length === 0 && catStr === undefined) {
    return;
  }
  ledger.ordered.push({
    feedback: {
      note: textStr,
      ...(catStr === undefined ? {} : { category: catStr }),
      kind: "session",
    },
  });
}

/** 单个事件对槽位台账的作用（非对象事件与未知类型都无副作用）。 */
function applyFeedbackEvent(event: unknown, ledger: SlotLedger): void {
  const evType = fieldOf(event, "type");
  const evData = fieldOf(event, "data");
  if (evType === "feedback/message-put") {
    applyMessagePut(evData, ledger, fieldOf(fieldOf(evData, "item"), "rating") === "negative");
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
 * 信号喂给蒸馏模型，蒸馏结果再进规则卡注入到后续每个会话。
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

/**
 * @file src/maid.ts
 * @description 女仆总线参与者：内置上下文窗口治理（掐头留尾截断, 历史瘦身, 逆序 Token 装箱, 水位归档提醒）与 Token 账单统计
 */
// @Antigravity, 20261118, [FEAT]: 升级上下文窗口治理与 Token 预算管理（原实现完整注释保留于下方）
// import type { Tool } from "ai";
// import { runLlmTurn, type LlmConfig } from "./providers.js";
// import type { BusParticipant, RawBusEventInput } from "./types.js";
//
// export interface MaidConsumedPrompt {
//   promptText: string;
//   requiresTool: boolean;
//   consumedEventIds: string[];
// }
//
// export interface MaidTurnResult {
//   finalText: string;
//   consumedEventIds: string[];
//   toolTrace: Array<{ toolName: string; args: unknown }>;
// }
//
// // @Antigravity, 20261118, [FEAT]: 新增扩展感知目录纯函数格式化器
// export function createMaidParticipant(config: {
//   nodeId: string;
//   llm: Omit<LlmConfig, "enabled"> & { enabled?: boolean };
//   getTools: () => Record<string, Tool>;
// }): BusParticipant<MaidConsumedPrompt, MaidTurnResult> {
//   return {
//     id: config.nodeId,
//     consume(eventsWindow, pendingBatch, extra) {
//       if (pendingBatch.length === 0) return null;
//       const requiresTool = pendingBatch.some((e) => e.responseMode === "tool_required");
//       const allOptional = pendingBatch.every((e) => e.responseMode === "optional");
//       const sections: string[] = [];
//       if (extra?.diary) {
//         sections.push(`## 0. 工作区长期备忘 (workspace/DIARY.md)\n${extra.diary}\n`);
//       }
//       sections.push(
//         `## 1. 历史事件窗口 (eventsWindow - 其中 END_TURN 结算之前的事项已处理完毕)`,
//         JSON.stringify(eventsWindow, null, 2),
//         ``,
//         `## 2. 本轮触发原因 (${extra?.triggerReason ?? "WAKE"}) 与待消费事件批次`,
//         JSON.stringify(pendingBatch, null, 2),
//         ``,
//         `## 3. 本轮响应要求`,
//         requiresTool
//           ? "- 【强制调用工具】待办中含有 tool_required 事件，本轮必须调用相应工具。"
//           : allOptional
//           ? "- 【可选回应】待办均为 optional 事件，若评估无需操作可直接简短回复结束本轮。"
//           : "- 【必须回应】请处理本轮待办事项并给出明确结论。"
//       );
//       return {
//         promptText: sections.join("\n"),
//         requiresTool,
//         consumedEventIds: pendingBatch.map((e) => e.id),
//       };
//     },
//     produce(turnResult): RawBusEventInput[] {
//       return [
//         {
//           source: config.nodeId,
//           target: config.nodeId,
//           type: "END_TURN",
//           prompt: turnResult.finalText || "(Turn finished)",
//           wake: false,
//           responseMode: "optional",
//           outbound: false,
//           payload: {
//             processedEventIds: turnResult.consumedEventIds,
//             toolTrace: turnResult.toolTrace,
//           },
//         },
//       ];
//     },
//     async execute(input) {
//       const { finalText, toolTrace } = await runLlmTurn({
//         llm: config.llm,
//         tools: config.getTools(),
//         promptText: input.promptText,
//         requiresTool: input.requiresTool,
//       });
//       return {
//         finalText,
//         consumedEventIds: input.consumedEventIds,
//         toolTrace,
//       };
//     },
//   };
// }

import type { Tool } from "ai";
// @Antigravity, 20261118, [FEAT]: 导入 ParticipantManifest 用于拼装已挂载扩展感知目录
// import type { BusEvent, BusParticipant, RawBusEventInput } from "./types.js";
import type { BusEvent, BusParticipant, ParticipantManifest, RawBusEventInput } from "./types.js";
import { runLlmTurn, type LlmRuntimeConfig } from "./providers.js";

export interface ContextBudgetConfig {
  /** 历史 + 待办 + Diary 的总输入 Token 预算上限 (默认 12000) */
  maxContextTokens?: number;
  /** DIARY.md 最大允许占用的 Token 数 (默认 2000) */
  maxDiaryTokens?: number;
  /** 单条字段/载荷字符串最大字符数, 超出则掐头留尾截断 (默认 1600) */
  maxFieldChars?: number;
  /** 触发自动更新 DIARY.md 提醒的水位线比例 (默认 0.75) */
  compactionWatermarkRatio?: number;
}

export interface TokenUsageStats {
  estimatedInputTokens: number;
  droppedHistoryEvents: number;
  apiInputTokens?: number;
  apiOutputTokens?: number;
  apiTotalTokens?: number;
}

export interface MaidConsumedPrompt {
  promptText: string;
  requiresTool: boolean;
  consumedEventIds: string[];
  budgetStats: {
    estimatedInputTokens: number;
    keptHistoryEvents: number;
    droppedHistoryEvents: number;
    compactionAdvised: boolean;
  };
}

export interface MaidTurnResult {
  finalText: string;
  consumedEventIds: string[];
  toolTrace: Array<{ toolName: string; args: unknown }>;
  tokenUsage?: TokenUsageStats;
}

/**
 * 轻量级中英混合 Token 估算器 (纯函数)
 * - CJK 汉字/全角符号按 ~1.5 tokens/char 估算
 * - ASCII/代码/JSON 按 ~0.28 tokens/char 估算
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) cjkCount++;
  }
  const asciiCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + asciiCount * 0.28);
}

/**
 * 单条超长文本“掐头留尾”截断器 (保留前 45% + 后 45%)
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.45);
  const tailLen = Math.floor(maxChars * 0.45);
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n...[truncated ${omitted} chars]...\n${text.slice(-tailLen)}`;
}

/**
 * 对事件对象进行深层长字符串截断与历史瘦身 (纯函数, 不修改原事件引用)
 */
function sanitizeEventForPrompt(
  event: BusEvent,
  maxFieldChars: number,
  isHistoricalSettled: boolean
): Record<string, unknown> {
  const deepTruncate = (val: unknown, limit: number): unknown => {
    if (typeof val === "string") return truncateMiddle(val, limit);
    if (Array.isArray(val)) return val.map((item) => deepTruncate(item, limit));
    if (val && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = deepTruncate(v, limit);
      }
      return out;
    }
    return val;
  };

  // 已结算的历史事件进一步收紧单字段限额, 压缩旧 toolTrace 体积
  const effectiveLimit = isHistoricalSettled ? Math.floor(maxFieldChars * 0.5) : maxFieldChars;

  return {
    id: event.id,
    ts: event.ts,
    source: event.source,
    target: event.target,
    type: event.type,
    prompt: truncateMiddle(event.prompt, effectiveLimit),
    responseMode: event.responseMode,
    payload: deepTruncate(event.payload, effectiveLimit),
  };
}

// @Antigravity, 20261118, [FEAT]: 新增扩展感知目录纯函数格式化器
/**
 * 将已注册的 BusParticipant 列表格式化为紧凑的 LLM 可读契约目录 (纯函数)
 */
function formatExtensionsCatalog(
  extensions?: ReadonlyArray<{ id: string; manifest?: ParticipantManifest }>
): string {
  if (!extensions || extensions.length === 0) return "";

  const catalog = extensions.map((ext) => ({
    participantId: ext.id,
    description: ext.manifest?.description ?? "(未提供描述, 仅通过事件流交互)",
    consumesToTriggerViaEmitEvent: ext.manifest?.consumes ?? [],
    producesToBus: ext.manifest?.produces ?? [],
  }));

  return [
    `## 0.5 已挂载总线扩展目录 (Mounted Extensions - 可通过 emit_event 指定 target/type 交互)`,
    JSON.stringify(catalog, null, 2),
    ``,
  ].join("\n");
}

export function createMaidParticipant(config: {
  nodeId: string;
  llm: LlmRuntimeConfig;
  budget?: ContextBudgetConfig;
  getTools: () => Record<string, Tool>;
}): BusParticipant<MaidConsumedPrompt, MaidTurnResult> {
  const maxContextTokens = config.budget?.maxContextTokens ?? 12_000;
  const maxDiaryTokens = config.budget?.maxDiaryTokens ?? 2_000;
  const maxFieldChars = config.budget?.maxFieldChars ?? 1_600;
  const watermarkRatio = config.budget?.compactionWatermarkRatio ?? 0.75;

  return {
    id: config.nodeId,

    /**
     * 【LLM 的纯消费动作 Consume】：组装并治理上下文窗口
     * 1. 保底分配 pendingBatch 与截断后的 DIARY.md
     * 2. 从 eventsWindow 剔除与本轮 pendingBatch 重复的项, 并从新到旧按剩余 Token 预算倒序装箱
     * 3. 超水位或发生历史丢弃时, 自动注入 DIARY.md 压缩归档指令
     */
    consume(eventsWindow, pendingBatch, extra) {
      if (pendingBatch.length === 0) return null;

      const requiresTool = pendingBatch.some((e) => e.responseMode === "tool_required");
      const allOptional = pendingBatch.every((e) => e.responseMode === "optional");

      // 1. 刚性区 A：处理本轮待办批次 (不丢弃条目, 仅对超长单字段做掐头留尾保护)
      const sanitizedBatch = pendingBatch.map((e) => sanitizeEventForPrompt(e, maxFieldChars, false));
      const batchJson = JSON.stringify(sanitizedBatch, null, 2);
      const batchTokens = estimateTokens(batchJson);

      // 2. 刚性区 B：处理 DIARY.md (受 maxDiaryTokens 约束)
      let diarySection = "";
      let diaryTokens = 0;
      if (extra?.diary) {
        const maxDiaryChars = maxDiaryTokens * 3;
        const safeDiary = truncateMiddle(extra.diary, maxDiaryChars);
        diarySection = `## 0. 工作区长期备忘 (workspace/DIARY.md)\n${safeDiary}\n`;
        diaryTokens = estimateTokens(diarySection);
      }

      // @Antigravity, 20261118, [FEAT]: 刚性区 C：已挂载扩展感知目录
      const extensionsSection = formatExtensionsCatalog(extra?.extensions);
      const extensionsTokens = estimateTokens(extensionsSection);

      // 3. 弹性滑动区：计算留给 eventsWindow 的剩余 Token 预算, 从最新往最旧倒序装箱
      const reservedOverheadTokens = 350;
      // const remainingForHistory = Math.max(
      //   500,
      //   maxContextTokens - batchTokens - diaryTokens - reservedOverheadTokens
      // );
      const remainingForHistory = Math.max(
        500,
        maxContextTokens - batchTokens - diaryTokens - extensionsTokens - reservedOverheadTokens
      );

      const pendingIds = new Set(pendingBatch.map((e) => e.id));
      const historyCandidates = eventsWindow.filter((e) => !pendingIds.has(e.id));

      const packedHistory: Record<string, unknown>[] = [];
      let usedHistoryTokens = 0;
      let droppedHistoryEvents = 0;

      for (let i = historyCandidates.length - 1; i >= 0; i--) {
        const slimmed = sanitizeEventForPrompt(historyCandidates[i], maxFieldChars, true);
        const itemTokens = estimateTokens(JSON.stringify(slimmed));
        if (usedHistoryTokens + itemTokens <= remainingForHistory) {
          packedHistory.unshift(slimmed);
          usedHistoryTokens += itemTokens;
        } else {
          droppedHistoryEvents = i + 1;
          break;
        }
      }

      const historyJson = JSON.stringify(packedHistory, null, 2);
      // @Antigravity, 20261118, [FEAT]: 计入 extensionsTokens 并插入扩展感知目录段落
      // const totalEstimatedTokens =
      //   diaryTokens + usedHistoryTokens + batchTokens + reservedOverheadTokens;
      const totalEstimatedTokens =
        diaryTokens + extensionsTokens + usedHistoryTokens + batchTokens + reservedOverheadTokens;
      const compactionAdvised =
        droppedHistoryEvents > 0 || totalEstimatedTokens >= maxContextTokens * watermarkRatio;

      // 4. 组装最终 Prompt
      const sections: string[] = [];
      if (diarySection) sections.push(diarySection);
      if (extensionsSection) sections.push(extensionsSection);

      sections.push(
        `## 1. 历史事件窗口 (eventsWindow - 保留最近 ${packedHistory.length} 条，因预算截断 ${droppedHistoryEvents} 条早期事件)`,
        historyJson,
        ``,
        `## 2. 本轮触发原因 (${extra?.triggerReason ?? "WAKE"}) 与待消费事件批次`,
        batchJson,
        ``,
        `## 3. 本轮响应要求`,
        requiresTool
          ? "- 【强制调用工具】待办中含有 tool_required 事件，本轮必须调用相应工具。"
          : allOptional
          ? "- 【可选回应】待办均为 optional 事件，若评估无需操作可直接简短回复结束本轮。"
          : "- 【必须回应】请处理本轮待办事项并给出明确结论。"
      );

      if (compactionAdvised) {
        sections.push(
          `- 【上下文水位告警】当前上下文已达 ${totalEstimatedTokens}/${maxContextTokens} tokens（已截断 ${droppedHistoryEvents} 条旧事件）。若历史窗口中有重要长期状态，请在本轮使用 write_file 更新至 DIARY.md 进行归档压缩。`
        );
      }

      return {
        promptText: sections.join("\n"),
        requiresTool,
        consumedEventIds: pendingBatch.map((e) => e.id),
        budgetStats: {
          estimatedInputTokens: totalEstimatedTokens,
          keptHistoryEvents: packedHistory.length,
          droppedHistoryEvents,
          compactionAdvised,
        },
      };
    },

    /**
     * 【LLM 的纯生产动作 Produce】：将结算结果与 Token 账单一并封入 END_TURN
     */
    produce(turnResult): RawBusEventInput[] {
      return [
        {
          source: config.nodeId,
          target: config.nodeId,
          type: "END_TURN",
          prompt: turnResult.finalText || "(Turn finished)",
          wake: false,
          responseMode: "optional",
          outbound: false,
          payload: {
            processedEventIds: turnResult.consumedEventIds,
            toolTrace: turnResult.toolTrace,
            ...(turnResult.tokenUsage ? { tokenUsage: turnResult.tokenUsage } : {}),
          },
        },
      ];
    },

    async execute(input) {
      const res = await runLlmTurn({
        llm: config.llm,
        prompt: input.promptText,
        tools: config.getTools(),
        requiresTool: input.requiresTool,
      });

      return {
        finalText: res.text,
        consumedEventIds: input.consumedEventIds,
        toolTrace: res.toolTrace,
        tokenUsage: {
          estimatedInputTokens: input.budgetStats.estimatedInputTokens,
          droppedHistoryEvents: input.budgetStats.droppedHistoryEvents,
          apiInputTokens: res.usage?.inputTokens,
          apiOutputTokens: res.usage?.outputTokens,
          apiTotalTokens: res.usage?.totalTokens,
        },
      };
    },
  };
}

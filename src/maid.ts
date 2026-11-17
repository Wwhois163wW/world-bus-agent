import { ToolLoopAgent, stepCountIs, type Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { BusEvent, BusParticipant, RawBusEventInput } from "./types.js";

export interface MaidConsumedPrompt {
  promptText: string;
  requiresTool: boolean;
  consumedEventIds: string[];
}

export interface MaidTurnResult {
  finalText: string;
  consumedEventIds: string[];
  toolTrace: Array<{ toolName: string; args: unknown }>;
}

export function createMaidParticipant(config: {
  nodeId: string;
  llm: { baseURL: string; apiKey: string; model: string; systemPrompt: string; maxSteps: number };
  getTools: () => Record<string, Tool>;
}): BusParticipant<MaidConsumedPrompt, MaidTurnResult> {
  return {
    id: config.nodeId,

    /**
     * 【LLM 的纯消费动作 Consume】：对应粉色图中的 generatePrompt 节点
     * 纯函数组装：DIARY.md + eventsWindow 历史背景 + 本轮 Stock/Wake 待办批次 -> Prompt
     */
    consume(eventsWindow, pendingBatch, extra) {
      if (pendingBatch.length === 0) return null;

      const requiresTool = pendingBatch.some((e) => e.responseMode === "tool_required");
      const allOptional = pendingBatch.every((e) => e.responseMode === "optional");

      const sections: string[] = [];
      if (extra?.diary) {
        sections.push(`## 0. 工作区长期备忘 (workspace/DIARY.md)\n${extra.diary}\n`);
      }

      sections.push(
        `## 1. 历史事件窗口 (eventsWindow - 其中 END_TURN 结算之前的事项已处理完毕)`,
        JSON.stringify(eventsWindow, null, 2),
        ``,
        `## 2. 本轮触发原因 (${extra?.triggerReason ?? "WAKE"}) 与待消费事件批次`,
        JSON.stringify(pendingBatch, null, 2),
        ``,
        `## 3. 本轮响应要求`,
        requiresTool
          ? "- 【强制调用工具】待办中含有 tool_required 事件，本轮必须调用相应工具。"
          : allOptional
          ? "- 【可选回应】待办均为 optional 事件，若评估无需操作可直接简短回复结束本轮。"
          : "- 【必须回应】请处理本轮待办事项并给出明确结论。"
      );

      return {
        promptText: sections.join("\n"),
        requiresTool,
        consumedEventIds: pendingBatch.map((e) => e.id),
      };
    },

    /**
     * 【LLM 的纯生产动作 Produce】：对应粉色图中的 endTurn 结算写回
     * 将本轮推理文本、已消费事件 ID 列表、工具调用轨迹纯函数打包为 END_TURN 事件
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
          },
        },
      ];
    },

    /** 执行 ToolLoopAgent 推理循环 */
    async execute(input) {
      const provider = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: config.llm.baseURL,
        apiKey: config.llm.apiKey,
      });

      const agent = new ToolLoopAgent({
        model: provider(config.llm.model),
        instructions: config.llm.systemPrompt,
        tools: config.getTools(),
        toolChoice: input.requiresTool ? "required" : "auto",
        stopWhen: stepCountIs(config.llm.maxSteps),
      });

      const res = await agent.generate({ prompt: input.promptText });
      const toolTrace = res.steps.flatMap((s) =>
        (s.toolCalls ?? []).map((tc) => ({ toolName: tc.toolName, args: tc.args }))
      );

      return {
        finalText: res.text,
        consumedEventIds: input.consumedEventIds,
        toolTrace,
      };
    },
  };
}

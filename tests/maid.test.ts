import { describe, it, expect } from "vitest";
import { createMaidParticipant } from "../src/maid.js";
import type { BusEvent } from "../src/types.js";

describe("Maid BusParticipant Pure Consume & Produce (src/maid.ts)", () => {
  const maid = createMaidParticipant({
    nodeId: "leadership.center",
    llm: {
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "test-key",
      model: "deepseek-chat",
      systemPrompt: "System prompt",
      maxSteps: 5,
    },
    getTools: () => ({}),
  });

  it("consume (generatePrompt): 待办为空时返回 null；非空时正确拼装 DIARY.md、eventsWindow 与工具约束", () => {
    expect(maid.consume([], [])).toBeNull();

    const windowEvents: BusEvent[] = [
      {
        id: "EVT-1",
        ts: "2026-11-17T00:00:00Z",
        source: "user",
        target: "leadership.center",
        type: "USER_AIM",
        prompt: "测聚乙烯老化样品",
        wake: true,
        responseMode: "tool_required",
        outbound: true,
        payload: {},
      },
    ];

    const consumed = maid.consume(windowEvents, windowEvents, {
      diary: "当前活跃课题: pe_aging_2026",
      triggerReason: "WAKE_BY_USER_AIM",
    });

    expect(consumed).not.toBeNull();
    expect(consumed!.requiresTool).toBe(true);
    expect(consumed!.consumedEventIds).toEqual(["EVT-1"]);
    expect(consumed!.promptText).toContain("当前活跃课题: pe_aging_2026");
    expect(consumed!.promptText).toContain("【强制调用工具】");
  });

  it("produce (endTurn): 纯函数打包 END_TURN 结算事件，记录 processedEventIds 与 toolTrace", () => {
    const produced = maid.produce({
      finalText: "已完成 OrderForm 起草",
      consumedEventIds: ["EVT-1", "EVT-2"],
      toolTrace: [{ toolName: "write_file", args: { path: "OrderForm.yaml" } }],
    });

    expect(produced).toHaveLength(1);
    expect(produced[0]).toMatchObject({
      source: "leadership.center",
      target: "leadership.center",
      type: "END_TURN",
      wake: false,
      outbound: false,
      payload: {
        processedEventIds: ["EVT-1", "EVT-2"],
        toolTrace: [{ toolName: "write_file", args: { path: "OrderForm.yaml" } }],
      },
    });
  });
});

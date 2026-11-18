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

  // @Antigravity, 20261118, [TEST]: 新增上下文窗口治理测试（掐头留尾截断与逆序 Token 装箱）
  it("上下文治理 1: 单条超长输出自动掐头留尾截断，防止撑爆窗口", () => {
    const smallMaid = createMaidParticipant({
      nodeId: "leadership.center",
      llm: { baseURL: "", apiKey: "k", model: "m", systemPrompt: "s", maxSteps: 2 },
      budget: { maxFieldChars: 200 },
      getTools: () => ({}),
    });

    const hugeLog = "HEAD_MARKER_" + "x".repeat(1000) + "_TAIL_MARKER";
    const evt: BusEvent = {
      id: "EVT-HUGE",
      ts: "2026-11-18T00:00:00Z",
      source: "dry.hub.01",
      target: "leadership.center",
      type: "NMREADY_FAIL",
      prompt: hugeLog,
      wake: true,
      responseMode: "respond",
      outbound: true,
      payload: { stderr: hugeLog },
    };

    const consumed = smallMaid.consume([evt], [evt]);
    expect(consumed!.promptText).toContain("HEAD_MARKER_");
    expect(consumed!.promptText).toContain("_TAIL_MARKER");
    expect(consumed!.promptText).toContain("...[truncated ");
    expect(consumed!.promptText.length).toBeLessThan(1200);
  });

  it("上下文治理 2: 逆序 Token 预算装箱，超出预算时自动淘汰最旧历史并触发 DIARY.md 归档提醒", () => {
    const tightMaid = createMaidParticipant({
      nodeId: "leadership.center",
      llm: { baseURL: "", apiKey: "k", model: "m", systemPrompt: "s", maxSteps: 2 },
      budget: { maxContextTokens: 800, maxFieldChars: 500 },
      getTools: () => ({}),
    });

    const history: BusEvent[] = Array.from({ length: 10 }, (_, i) => ({
      id: `EVT-HIST-${i + 1}`,
      ts: `2026-11-18T00:0${i}:00Z`,
      source: "wet.sentinel",
      target: "leadership.center",
      type: "HISTORY_LOG",
      prompt: `这是第 ${i + 1} 条历史记录，包含一些实验过程描述数据以占用一定的 Token 预算空间。`,
      wake: false,
      responseMode: "optional",
      outbound: true,
      payload: { step: i + 1 },
    }));

    const trigger: BusEvent = {
      id: "EVT-NOW",
      ts: "2026-11-18T01:00:00Z",
      source: "user",
      target: "leadership.center",
      type: "USER_CMD",
      prompt: "立即汇总当前状态",
      wake: true,
      responseMode: "respond",
      outbound: true,
      payload: {},
    };

    const consumed = tightMaid.consume([...history, trigger], [trigger]);
    expect(consumed).not.toBeNull();
    expect(consumed!.budgetStats.droppedHistoryEvents).toBeGreaterThan(0);
    expect(consumed!.budgetStats.keptHistoryEvents).toBeLessThan(10);
    expect(consumed!.budgetStats.compactionAdvised).toBe(true);
    expect(consumed!.promptText).toContain("EVT-HIST-10");
    expect(consumed!.promptText).not.toContain('EVT-HIST-1"');
    expect(consumed!.promptText).toContain("【上下文水位告警】");
  });
});

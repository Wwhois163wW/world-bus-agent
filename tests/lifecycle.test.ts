import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime, type RuntimeConfig } from "../src/main.js";

describe("Event Lifecycle Engine - Pink Diagram (src/main.ts)", () => {
  let workspaceDir: string;
  let baseConfig: RuntimeConfig;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "wba-lifecycle-"));
    baseConfig = {
      nodeId: "leadership.center",
      workspaceDir,
      port: 0,
      windowSize: 20,
      tickIntervalMs: 0,
      llm: {
        enabled: true,
        baseURL: "http://localhost",
        apiKey: "mock-key",
        model: "mock-model",
        systemPrompt: "Test",
        maxSteps: 3,
      },
      extensions: [],
    };
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("1. Flag 分流与 Tick 排空: wake=false 进 Stock 不唤醒女仆；Tick 脉冲一次性排空 Stock 并写入 END_TURN", async () => {
    const maidCalls: string[][] = [];
    const runtime = await createAgentRuntime(baseConfig, {
      maidExecute: async (input) => {
        maidCalls.push(input.consumedEventIds);
        return {
          finalText: "Batch processed on tick",
          consumedEventIds: input.consumedEventIds,
          toolTrace: [],
        };
      },
    });

    // 注入两条 wake: false 事件 -> 应落盘并进入 Stock，但女仆保持 standby
    const e1 = await runtime.bus.ingest({
      source: "wet.sentinel",
      target: "leadership.center",
      type: "LOG_INFO",
      prompt: "队列扫描正常 1",
      wake: false,
    });
    const e2 = await runtime.bus.ingest({
      source: "wet.sentinel",
      target: "leadership.center",
      type: "LOG_INFO",
      prompt: "队列扫描正常 2",
      wake: false,
    });

    expect(maidCalls).toHaveLength(0);
    expect(runtime.getState().stock.map((e) => e.id)).toEqual([e1.id, e2.id]);

    // 触发旁路 Tick 脉冲 -> 排空 Stock 唤醒女仆，并在账本追加 END_TURN
    await runtime.bus.tick("MANUAL_TEST_TICK");

    expect(maidCalls).toEqual([[e1.id, e2.id]]);
    expect(runtime.getState().stock).toHaveLength(0);

    const windowTypes = runtime.getState().eventsWindow.map((e) => e.type);
    expect(windowTypes).toEqual(["LOG_INFO", "LOG_INFO", "END_TURN"]);
  });

  it("2. Busy 互斥锁与 endTurn 自动续接: 女仆忙碌期间涌入的事件退入 Stock，并在 endTurn 后自动开启第二轮排空", async () => {
    const turnBatches: string[][] = [];
    let runtimeRef!: Awaited<ReturnType<typeof createAgentRuntime>>;

    runtimeRef = await createAgentRuntime(baseConfig, {
      maidExecute: async (input) => {
        turnBatches.push(input.consumedEventIds);
        // 当女仆正在处理第 1 轮 (Busy=true) 时，外部突然塞入一条 wake:true 和一条 wake:false 事件
        if (turnBatches.length === 1) {
          await runtimeRef.bus.ingest({
            source: "dry.hub.01",
            target: "leadership.center",
            type: "URGENT_DURING_BUSY",
            prompt: "忙碌期紧急事件",
            wake: true,
          });
          await runtimeRef.bus.ingest({
            source: "wet.sentinel",
            target: "leadership.center",
            type: "SILENT_DURING_BUSY",
            prompt: "忙碌期静默事件",
            wake: false,
          });
          // 此时因为 Busy=true，这两条必须都在 Stock 中排队
          expect(runtimeRef.getState().busy).toBe(true);
          expect(runtimeRef.getState().stock).toHaveLength(2);
        }
        return {
          finalText: `Turn ${turnBatches.length} done`,
          consumedEventIds: input.consumedEventIds,
          toolTrace: [],
        };
      },
    });

    // 注入第 1 条唤醒事件启动闭环
    await runtimeRef.bus.ingest({
      source: "user.gui",
      target: "leadership.center",
      type: "FIRST_WAKE",
      prompt: "启动第一轮",
      wake: true,
    });

    // 验证：总共自动跑了 2 轮（第 1 轮处理 FIRST_WAKE，endTurn 发现 Stock 有 2 条积压，立刻自动跑第 2 轮排空）
    expect(turnBatches).toHaveLength(2);
    expect(turnBatches[0]).toHaveLength(1);
    expect(turnBatches[1]).toHaveLength(2);
    expect(runtimeRef.getState().stock).toHaveLength(0);
    expect(runtimeRef.getState().busy).toBe(false);
  });

  it("3. 断电重启恢复: 自动从 events.jsonl 恢复 eventsWindow，且仅将未被 END_TURN 签收的遗留事件装回 Stock", async () => {
    const preExistingEvents = [
      {
        id: "EVT-SETTLED-1",
        ts: "2026-11-17T01:00:00Z",
        source: "wet",
        target: "leadership.center",
        type: "OLD_EVENT",
        prompt: "已结算事件",
        wake: false,
        responseMode: "optional",
        outbound: true,
        payload: {},
      },
      {
        id: "EVT-END-1",
        ts: "2026-11-17T01:01:00Z",
        source: "leadership.center",
        target: "leadership.center",
        type: "END_TURN",
        prompt: "Done",
        wake: false,
        responseMode: "optional",
        outbound: false,
        payload: { processedEventIds: ["EVT-SETTLED-1"] },
      },
      {
        id: "EVT-UNSETTLED-2",
        ts: "2026-11-17T01:02:00Z",
        source: "dry",
        target: "leadership.center",
        type: "PENDING_EVENT",
        prompt: "断电前未结算事件",
        wake: false,
        responseMode: "respond",
        outbound: true,
        payload: {},
      },
    ];

    await writeFile(
      join(workspaceDir, "events.jsonl"),
      preExistingEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8"
    );

    const runtime = await createAgentRuntime(baseConfig);
    const state = runtime.getState();

    // eventsWindow 恢复全部 3 条历史
    expect(state.eventsWindow).toHaveLength(3);
    // Stock 仅恢复未被 END_TURN 签收的 EVT-UNSETTLED-2
    expect(state.stock.map((e) => e.id)).toEqual(["EVT-UNSETTLED-2"]);
  });
});

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { loadConfig } from "c12";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Tool } from "ai";
import {
  BusEventSchema,
  type AgentExtension,
  type BusEvent,
  type BusParticipant,
  type RawBusEventInput,
  type WorldBusContext,
} from "./types.js";
import { createNativeWorkspaceTools } from "./tools.js";
import { createMaidParticipant } from "./maid.js";

async function bootstrap() {
  const { config } = await loadConfig({
    name: "agent",
    defaults: {
      nodeId: process.env.AGENT_NODE_ID || "leadership.center",
      workspaceDir: "./workspace",
      port: Number(process.env.AGENT_PORT || 3100),
      windowSize: 40,
      tickIntervalMs: 0,
      llm: {
        enabled: Boolean(process.env.LLM_API_KEY),
        baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
        apiKey: process.env.LLM_API_KEY || "",
        model: process.env.LLM_MODEL || "deepseek-chat",
        systemPrompt: "你是工作区内的自律智能体女仆，通过消费事件流并调用工具完成任务。",
        maxSteps: 8,
      },
      extensions: [] as Array<{ module: string; options?: Record<string, unknown> }>,
    },
  });

  const workspaceDir = resolve(config.workspaceDir);
  await mkdir(workspaceDir, { recursive: true });
  const eventsLogPath = join(workspaceDir, "events.jsonl");
  const deadletterPath = join(workspaceDir, "deadletter.jsonl");
  const diaryPath = join(workspaceDir, "DIARY.md");

  // === 粉色图中的核心状态容器 ===
  const eventsWindow: BusEvent[] = [];
  const stock: BusEvent[] = [];
  let busy = false;

  const tools: Record<string, Tool> = {};
  const participants: BusParticipant<any, any>[] = [];

  // 启动恢复：从 events.jsonl 恢复 eventsWindow，并将未经过 END_TURN 签收的遗留事件恢复进 Stock
  if (existsSync(eventsLogPath)) {
    const lines = (await readFile(eventsLogPath, "utf-8")).trim().split("\n").filter(Boolean);
    const allParsed: BusEvent[] = [];
    const settledIds = new Set<string>();

    for (const line of lines) {
      try {
        const evt = BusEventSchema.parse(JSON.parse(line));
        allParsed.push(evt);
        if (evt.type === "END_TURN" && Array.isArray(evt.payload.processedEventIds)) {
          for (const id of evt.payload.processedEventIds) settledIds.add(String(id));
        }
      } catch {}
    }

    eventsWindow.push(...allParsed.slice(-config.windowSize));
    for (const evt of allParsed) {
      const isExternalForMe =
        evt.source !== config.nodeId && (evt.target === config.nodeId || evt.target === "*");
      if (isExternalForMe && !settledIds.has(evt.id)) {
        stock.push(evt);
      }
    }
  }

  /** 左上角管道：Event -> Zod -> update events.jsonl -> build eventsWindow */
  async function recordToLedger(raw: RawBusEventInput): Promise<BusEvent> {
    const parsed = BusEventSchema.safeParse({
      id: `EVT-${Date.now()}-${randomUUID().slice(0, 5)}`,
      ts: new Date().toISOString(),
      ...raw,
    });

    if (!parsed.success) {
      // 异常分流 1：Zod 格式校验失败写入 deadletter.jsonl，不污染总线
      await appendFile(
        deadletterPath,
        JSON.stringify({ ts: new Date().toISOString(), raw, error: parsed.error.flatten() }) + "\n"
      );
      throw new Error(`Event Zod 校验失败: ${parsed.error.message}`);
    }

    const event = parsed.data;
    await appendFile(eventsLogPath, JSON.stringify(event) + "\n", "utf-8");
    eventsWindow.push(event);
    if (eventsWindow.length > config.windowSize) eventsWindow.shift();
    return event;
  }

  // 实例化女仆参与者 (Maid BusParticipant)
  const maid = createMaidParticipant({
    nodeId: config.nodeId,
    llm: config.llm,
    getTools: () => tools,
  });

  /** 右半部闭环：generatePrompt (maid.consume) -> Busy -> 女仆执行 -> endTurn (maid.produce) -> Stock */
  async function triggerMaidTurn(incomingWake: BusEvent[], reason: string): Promise<void> {
    // [菱形 Busy]：若女仆正忙，新来的唤醒事件直接退入 Stock 排队
    if (busy) {
      stock.push(...incomingWake);
      return;
    }

    const batch = [...stock.splice(0), ...incomingWake];
    if (batch.length === 0 || !config.llm.enabled || !config.llm.apiKey) return;

    busy = true;
    try {
      const diary = existsSync(diaryPath) ? await readFile(diaryPath, "utf-8") : undefined;

      // 1. 女仆执行纯消费动作 (consume = generatePrompt)
      const consumedPrompt = maid.consume(eventsWindow, batch, { diary, triggerReason: reason });
      if (!consumedPrompt || !maid.execute) return;

      // 2. 女仆执行推理与工具调用循环
      const turnResult = await maid.execute(consumedPrompt, bus);

      // 3. 女仆执行纯生产动作 (produce = 生成 END_TURN 结算事件) 并写回 events.jsonl
      const endTurnEvents = maid.produce(turnResult);
      for (const rawEvt of endTurnEvents) {
        await recordToLedger(rawEvt);
      }
    } catch (err) {
      // 异常分流 2：LLM API 超时或崩溃时，将本轮未完成的 batch 退回 Stock 队首，绝不吞事件
      stock.unshift(...batch);
      console.error(`[${config.nodeId}] 女仆推理异常，已将 ${batch.length} 条事件退回 Stock:`, err);
      return;
    } finally {
      busy = false;
    }

    // [endTurn -> Stock]：若忙碌期间 Stock 又积攒了新事件，立即开启下一轮排空
    if (stock.length > 0) {
      await triggerMaidTurn([], "DRAIN_STOCK_AFTER_END_TURN");
    }
  }

  const bus: WorldBusContext = {
    nodeId: config.nodeId,
    workspaceDir,
    registerTool: (name, toolDef) => {
      tools[name] = toolDef;
    },
    registerParticipant: (p) => {
      participants.push(p);
    },
    ingest: async (raw) => {
      const event = await recordToLedger(raw);

      // 触发其他挂载在总线上的拓展参与者 (consume -> execute -> produce)
      for (const p of participants) {
        const input = p.consume(eventsWindow, [event]);
        if (input !== null && p.execute) {
          const out = await p.execute(input, bus);
          for (const produced of p.produce(out)) {
            await bus.ingest(produced);
          }
        }
      }

      // 菱形 Flag 分流：外部发往本节点的事件，按 event.wake 决定走 Wake 还是进 Stock
      const isForMe = event.target === config.nodeId || event.target === "*";
      if (isForMe && event.source !== config.nodeId) {
        if (event.wake) {
          await triggerMaidTurn([event], `WAKE_BY_${event.type}`);
        } else {
          stock.push(event);
        }
      }
      return event;
    },
    tick: async (reason = "TICK_PULSE") => {
      await triggerMaidTurn([], reason);
    },
  };

  Object.assign(tools, createNativeWorkspaceTools(bus));

  const jiti = createJiti(import.meta.url);
  for (const ext of config.extensions) {
    const mod = await jiti.import<{ default?: AgentExtension }>(ext.module);
    if (mod.default) await mod.default(bus, ext.options);
  }

  if (config.tickIntervalMs > 0) {
    setInterval(() => bus.tick("TIMER_TICK"), config.tickIntervalMs);
  }

  const app = new Hono();
  app.get("/status", (c) =>
    c.json({ nodeId: config.nodeId, busy, stockCount: stock.length, stock, recentWindow: eventsWindow.slice(-10) })
  );
  app.post("/events", async (c) => {
    const body = await c.req.json();
    const evt = await bus.ingest({ ...body, source: body.source || "external.http" });
    return c.json({ ok: true, event: evt }, 201);
  });
  app.post("/tick", async (c) => {
    await bus.tick("HTTP_TICK");
    return c.json({ ok: true, stockRemaining: stock.length });
  });

  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port });
  console.log(`[${config.nodeId}] Running -> http://127.0.0.1:${config.port}`);
}

bootstrap();

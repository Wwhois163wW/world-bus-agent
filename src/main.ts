import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createHooks } from "hookable";
import { createJiti } from "jiti";
import { loadConfig } from "c12";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { ToolLoopAgent, stepCountIs, type Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createNativeTools } from "./tools.js";
import {
  WorldEventSchema,
  type AgentContext,
  type AgentExtension,
  type AgentHooks,
  type WorldEvent,
} from "./types.js";

async function bootstrap() {
  const { config } = await loadConfig({
    name: "agent",
    defaults: {
      nodeId: process.env.AGENT_NODE_ID || "leadership.center",
      workspaceDir: "./workspace",
      port: Number(process.env.AGENT_PORT || 3100),
      windowSize: 40,
      tickIntervalMs: 0, // 若 > 0 则启动内置周期 Tick
      llm: {
        enabled: Boolean(process.env.LLM_API_KEY),
        baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
        apiKey: process.env.LLM_API_KEY || "",
        model: process.env.LLM_MODEL || "deepseek-chat",
        systemPrompt: "你是运行在工作区内的自律智能体。请根据 eventsWindow 背景与本轮待办事件处理任务。",
        maxSteps: 8,
      },
      extensions: [] as Array<{ module: string; options?: Record<string, unknown> }>,
    },
  });

  const workspaceDir = resolve(config.workspaceDir);
  await mkdir(workspaceDir, { recursive: true });
  const eventsLogPath = join(workspaceDir, "events.jsonl");

  // === 流程图中的 3 个核心状态容器 ===
  const eventsWindow: WorldEvent[] = []; // 圆圈: eventsWindow (历史背景窗口)
  const stock: WorldEvent[] = [];        // 圆圈: Stock (未唤醒/忙碌期积压待办池)
  let busy = false;                      // 菱形: Busy 互斥锁

  // 启动时从 events.jsonl 尾部恢复 eventsWindow
  if (existsSync(eventsLogPath)) {
    const lines = (await readFile(eventsLogPath, "utf-8")).trim().split("\n").filter(Boolean);
    for (const line of lines.slice(-config.windowSize)) {
      try {
        eventsWindow.push(WorldEventSchema.parse(JSON.parse(line)));
      } catch {}
    }
  }

  /** 落盘更新 events.jsonl 并同步更新 eventsWindow (对应: Zod -> update -> events.jsonl -> build -> eventsWindow) */
  async function recordToLedger(raw: Omit<WorldEvent, "id" | "ts"> & { id?: string; ts?: string }): Promise<WorldEvent> {
    const event = WorldEventSchema.parse({
      id: raw.id ?? `EVT-${Date.now()}-${randomUUID().slice(0, 5)}`,
      ts: raw.ts ?? new Date().toISOString(),
      ...raw,
    });
    await appendFile(eventsLogPath, JSON.stringify(event) + "\n", "utf-8");
    eventsWindow.push(event);
    if (eventsWindow.length > config.windowSize) {
      eventsWindow.shift();
    }
    return event;
  }

  /** 对应流程图中间的 generatePrompt 节点 (组装 eventsWindow 历史背景 + 本轮 Stock/Wake 待办) */
  function generatePrompt(pendingBatch: WorldEvent[], triggerReason: string) {
    // 若本轮待办中有任何一个声明了 tool_required，则强制要求调用工具
    const requiresTool = pendingBatch.some((e) => e.responseMode === "tool_required");
    const allOptional = pendingBatch.every((e) => e.responseMode === "optional");

    const promptText = [
      `## 1. 历史上下文窗口 (eventsWindow - 仅供参考，其中 endTurn 之前的事项已结算)`,
      JSON.stringify(eventsWindow, null, 2),
      ``,
      `## 2. 本轮触发原因 (${triggerReason}) 与待办事件批次 (Pending Inbox)`,
      JSON.stringify(pendingBatch, null, 2),
      ``,
      `## 3. 本轮响应约束`,
      requiresTool
        ? "- 【强制工具调用】本轮包含 tool_required 事件，你必须调用至少一个工具处理。"
        : allOptional
        ? "- 【可选回应】本轮均为 optional 事件，若评估无需动作可直接简短回复结束本轮。"
        : "- 【必须回应】请针对本轮待办事件执行必要操作并给出明确回应。",
    ].join("\n");

    return { promptText, requiresTool };
  }

  /**
   * 对应流程图右半部闭环: generatePrompt -> Busy -> 女仆(LLM) -> endTurn -> Stock
   */
  async function runTurn(incomingWakeEvents: WorldEvent[], reason: string): Promise<void> {
    // [菱形 Busy]: 如果女仆正忙，新来的唤醒事件直接退入 Stock 排队
    if (busy) {
      stock.push(...incomingWakeEvents);
      return;
    }

    // 抽空 Stock 中的所有积压事件 + 本次立即唤醒事件
    const batch = [...stock.splice(0), ...incomingWakeEvents];
    if (batch.length === 0) return;

    if (!config.llm.enabled || !config.llm.apiKey) return;

    busy = true;
    try {
      const { promptText, requiresTool } = generatePrompt(batch, reason);

      const provider = createOpenAICompatible({
        name: "llm-provider",
        baseURL: config.llm.baseURL,
        apiKey: config.llm.apiKey,
      });

      const maid = new ToolLoopAgent({
        model: provider(config.llm.model),
        instructions: config.llm.systemPrompt,
        tools,
        toolChoice: requiresTool ? "required" : "auto",
        stopWhen: stepCountIs(config.llm.maxSteps),
      });

      const result = await maid.generate({ prompt: promptText });

      // [菱形 endTurn]: 将女仆本轮的响应与 endTurn 结算标记写回 events.jsonl 和 eventsWindow！
      await recordToLedger({
        source: config.nodeId,
        target: config.nodeId,
        type: "END_TURN",
        prompt: result.text || "(Turn completed)",
        wake: false,
        responseMode: "optional",
        outbound: false,
        payload: {
          processedEventIds: batch.map((e) => e.id),
          toolCallsCount: result.steps.reduce((acc, s) => acc + (s.toolCalls?.length ?? 0), 0),
        },
      });
    } finally {
      busy = false;
      // [endTurn -> Stock -> generatePrompt]: 若忙碌期间 Stock 又进了新事件，立即开启下一轮排空
      if (stock.length > 0) {
        await runTurn([], "DRAIN_STOCK_AFTER_END_TURN");
      }
    }
  }

  const hooks = createHooks<AgentHooks>();
  const tools: Record<string, Tool> = {};

  const ctx: AgentContext = {
    nodeId: config.nodeId,
    workspaceDir,
    hooks,
    registerTool: (name, toolDef) => {
      tools[name] = toolDef;
    },
    /** 对应流程图左上角入口: Event -> Zod -> update events.jsonl -> build eventsWindow -> Flag */
    emit: async (input, meta = {}) => {
      const event = await recordToLedger({
        source: input.source ?? config.nodeId,
        target: input.target ?? "*",
        type: input.type,
        prompt: input.prompt,
        wake: input.wake ?? false,
        responseMode: input.responseMode ?? "optional",
        outbound: input.outbound ?? true,
        payload: input.payload ?? {},
      });

      // 通知挂载的外部拓展 (如 Redis 桥接插件或本地监听插件)
      await hooks.callHook("bus:event", event, meta);

      // 仅当目标包含本节点时，进入菱形 Flag 分流
      const isForMe = event.target === config.nodeId || event.target === "*";
      if (isForMe && event.source !== config.nodeId) {
        if (event.wake) {
          // Flag --(Wake)--> generatePrompt
          await runTurn([event], `WAKE_BY_${event.type}`);
        } else {
          // Flag --(not Wake)--> Stock
          stock.push(event);
        }
      }
      return event;
    },
    /** 对应流程图下方圆圈: Tick -> generatePrompt (不写日志，直接唤醒排空 Stock) */
    tick: async (reason = "TICK_PULSE") => {
      await runTurn([], reason);
    },
  };

  // 默认挂载 5 个 CLI 原生工具 (read_file, write_file, list_dir, exec_cli, emit_event)
  Object.assign(tools, createNativeTools(ctx));

  // 加载外部拓展插件
  const jiti = createJiti(import.meta.url);
  for (const ext of config.extensions) {
    const mod = await jiti.import<{ default?: AgentExtension }>(ext.module);
    if (mod.default) await mod.default(ctx, ext.options);
  }

  if (config.tickIntervalMs > 0) {
    setInterval(() => ctx.tick("INTERNAL_TIMER_TICK"), config.tickIntervalMs);
  }

  // Localhost 控制端口 (供外部脚本注入 Event、触发 Tick、查看状态)
  const app = new Hono();
  app.get("/status", (c) =>
    c.json({
      nodeId: config.nodeId,
      busy,
      stockCount: stock.length,
      stock,
      windowCount: eventsWindow.length,
      recentWindow: eventsWindow.slice(-10),
      tools: Object.keys(tools),
    })
  );
  app.post("/events", async (c) => {
    const body = await c.req.json();
    const evt = await ctx.emit({ ...body, source: body.source || "external.http" });
    return c.json({ ok: true, event: evt }, 201);
  });
  app.post("/tick", async (c) => {
    await ctx.tick("HTTP_TICK");
    return c.json({ ok: true, stockRemaining: stock.length });
  });

  await hooks.callHook("agent:ready", ctx);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port });
  console.log(`[${config.nodeId}] Ready -> http://127.0.0.1:${config.port}`);
}

bootstrap();

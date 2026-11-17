import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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
import { createMaidParticipant, type MaidConsumedPrompt, type MaidTurnResult } from "./maid.js";
import { dumpCrashReportSync, type CrashReport } from "./crash.js";

export interface RuntimeConfig {
  nodeId: string;
  workspaceDir: string;
  port: number;
  windowSize: number;
  tickIntervalMs: number;
  llm: {
    enabled: boolean;
    baseURL: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    maxSteps: number;
  };
  extensions: Array<{ module: string; options?: Record<string, unknown> }>;
}

export interface RuntimeOverrides {
  /** 测试专用：替换真实 LLM 网络请求 */
  maidExecute?: (input: MaidConsumedPrompt, bus: WorldBusContext) => Promise<MaidTurnResult>;
  /** 测试专用：拦截 process.exit(1) 以便断言底层崩溃 */
  onExit?: (code: number) => never | void;
}

export async function createAgentRuntime(
  config: RuntimeConfig,
  overrides: RuntimeOverrides = {}
) {
  const workspaceDir = resolve(config.workspaceDir);
  await mkdir(workspaceDir, { recursive: true });
  const eventsLogPath = join(workspaceDir, "events.jsonl");
  const diaryPath = join(workspaceDir, "DIARY.md");

  const eventsWindow: BusEvent[] = [];
  const stock: BusEvent[] = [];
  let busy = false;
  let crashed = false;

  const tools: Record<string, Tool> = {};
  const participants: BusParticipant<any, any>[] = [];
  const crashHandlers: Array<(report: CrashReport) => Promise<void> | void> = [];
  const exitFn = overrides.onExit ?? ((code: number) => process.exit(code));

  async function handleFatalCrash(
    stage: CrashReport["stage"],
    error: unknown,
    contextSnapshot?: unknown
  ): Promise<never> {
    crashed = true;
    const report = dumpCrashReportSync({
      nodeId: config.nodeId,
      workspaceDir,
      stage,
      error,
      contextSnapshot,
    });

    if (crashHandlers.length > 0) {
      await Promise.race([
        Promise.allSettled(crashHandlers.map((fn) => Promise.resolve().then(() => fn(report)))),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
    exitFn(1);
    throw error instanceof Error ? error : new Error(String(error));
  }

  // 1. 启动恢复：从 events.jsonl 恢复 eventsWindow 与未经过 END_TURN 签收的 Stock
  if (existsSync(eventsLogPath)) {
    const lines = (await readFile(eventsLogPath, "utf-8")).trim().split("\n").filter(Boolean);
    const allParsed: BusEvent[] = [];
    const settledIds = new Set<string>();

    for (let idx = 0; idx < lines.length; idx++) {
      try {
        const evt = BusEventSchema.parse(JSON.parse(lines[idx]));
        allParsed.push(evt);
        if (evt.type === "END_TURN" && Array.isArray(evt.payload.processedEventIds)) {
          for (const id of evt.payload.processedEventIds) settledIds.add(String(id));
        }
      } catch (err) {
        await handleFatalCrash("BOOT", err, {
          reason: `events.jsonl 第 ${idx + 1} 行损坏`,
          corruptedLine: lines[idx],
        });
      }
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

  /** Event -> Zod -> update events.jsonl -> build eventsWindow */
  async function recordToLedger(raw: RawBusEventInput): Promise<BusEvent> {
    const parsed = BusEventSchema.safeParse({
      id: `EVT-${Date.now()}-${randomUUID().slice(0, 5)}`,
      ts: new Date().toISOString(),
      ...raw,
    });
    if (!parsed.success) {
      const errMsg = `Invalid Event Schema from [${raw.source}]: ${parsed.error.message}`;
      throw new Error(errMsg);
    }

    const event = parsed.data;
    try {
      await appendFile(eventsLogPath, JSON.stringify(event) + "\n", "utf-8");
    } catch (ioErr) {
      await handleFatalCrash("LEDGER_IO", ioErr, { event });
    }

    eventsWindow.push(event);
    if (eventsWindow.length > config.windowSize) eventsWindow.shift();
    return event;
  }

  const maid = createMaidParticipant({
    nodeId: config.nodeId,
    llm: config.llm,
    getTools: () => tools,
  });
  if (overrides.maidExecute) {
    maid.execute = overrides.maidExecute;
  }

  /** generatePrompt -> Busy -> 女仆 -> endTurn -> Stock */
  async function triggerMaidTurn(incomingWake: BusEvent[], reason: string): Promise<void> {
    if (crashed) return;
    if (busy) {
      stock.push(...incomingWake);
      return;
    }

    const batch = [...stock.splice(0), ...incomingWake];
    if (batch.length === 0 || !config.llm.enabled) return;

    busy = true;
    try {
      const diary = existsSync(diaryPath) ? await readFile(diaryPath, "utf-8") : undefined;
      const consumedPrompt = maid.consume(eventsWindow, batch, { diary, triggerReason: reason });
      if (!consumedPrompt || !maid.execute) return;

      const turnResult = await maid.execute(consumedPrompt, bus);
      for (const rawEvt of maid.produce(turnResult)) {
        await recordToLedger(rawEvt);
      }
    } catch (llmErr) {
      await handleFatalCrash("MAID_TURN", llmErr, { triggerReason: reason, pendingBatch: batch });
    } finally {
      busy = false;
    }

    if (stock.length > 0 && !crashed) {
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
    onCrash: (handler) => {
      crashHandlers.push(handler);
    },
    ingest: async (raw) => {
      if (crashed) throw new Error(`[${config.nodeId}] Node is CRASHED.`);
      const event = await recordToLedger(raw);

      for (const p of participants) {
        const input = p.consume(eventsWindow, [event]);
        if (input !== null && p.execute) {
          try {
            const out = await p.execute(input, bus);
            for (const produced of p.produce(out)) {
              await bus.ingest(produced);
            }
          } catch (taskErr: any) {
            if (event.type !== "EXTENSION_TASK_ERROR") {
              await bus.ingest({
                source: p.id,
                target: config.nodeId,
                type: "EXTENSION_TASK_ERROR",
                prompt: `[拓展任务报错] 拓展 "${p.id}" 处理事件 "${event.type}" (${event.id}) 失败: ${taskErr?.message ?? String(taskErr)}`,
                wake: true,
                responseMode: "respond",
                outbound: true,
                payload: {
                  failedParticipant: p.id,
                  triggerEventId: event.id,
                  error: taskErr?.message ?? String(taskErr),
                },
              });
            }
          }
        }
      }

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
    try {
      const mod = await jiti.import<{ default?: AgentExtension }>(ext.module);
      if (!mod.default) throw new Error(`Extension [${ext.module}] missing default export`);
      await mod.default(bus, ext.options);
    } catch (bootErr) {
      await handleFatalCrash("BOOT", bootErr, { extensionModule: ext.module });
    }
  }

  const app = new Hono();
  app.get("/status", (c) =>
    c.json({
      nodeId: config.nodeId,
      crashed,
      busy,
      stockCount: stock.length,
      stock,
      windowCount: eventsWindow.length,
      recentWindow: eventsWindow.slice(-10),
      tools: Object.keys(tools),
    })
  );
  app.post("/events", async (c) => {
    try {
      const body = await c.req.json();
      const evt = await bus.ingest({ ...body, source: body.source || "external.http" });
      return c.json({ ok: true, event: evt }, 201);
    } catch (err: any) {
      return c.json({ ok: false, error: err.message ?? String(err) }, 400);
    }
  });
  app.post("/tick", async (c) => {
    await bus.tick("HTTP_TICK");
    return c.json({ ok: true, stockRemaining: stock.length });
  });

  return {
    bus,
    app,
    tools,
    getState: () => ({
      busy,
      crashed,
      stock: [...stock],
      eventsWindow: [...eventsWindow],
    }),
  };
}

export async function bootstrap() {
  const { config } = await loadConfig<RuntimeConfig>({
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
      extensions: [],
    },
  });

  process.on("uncaughtException", (err) => {
    dumpCrashReportSync({ nodeId: config.nodeId, workspaceDir: config.workspaceDir, stage: "UNCAUGHT", error: err });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    dumpCrashReportSync({ nodeId: config.nodeId, workspaceDir: config.workspaceDir, stage: "UNCAUGHT", error: reason });
    process.exit(1);
  });

  const runtime = await createAgentRuntime(config);
  if (config.tickIntervalMs > 0) {
    setInterval(() => runtime.bus.tick("TIMER_TICK"), config.tickIntervalMs);
  }
  serve({ fetch: runtime.app.fetch, hostname: "127.0.0.1", port: config.port });
  console.log(`[${config.nodeId}] Ready -> http://127.0.0.1:${config.port}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrap();
}

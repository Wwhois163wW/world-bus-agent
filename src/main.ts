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
// @Antigravity, 20261118, [FEAT]: 支持在 RuntimeConfig 中配置上下文治理预算 ContextBudgetConfig
// import { createMaidParticipant, type MaidConsumedPrompt, type MaidTurnResult } from "./maid.js";
import {
  createMaidParticipant,
  type ContextBudgetConfig,
  type MaidConsumedPrompt,
  type MaidTurnResult,
} from "./maid.js";
import { dumpCrashReportSync, type CrashReport } from "./crash.js";
// @Antigravity, 20261118, [FEAT]: 引入提供商预设与连通性测试模块
import { PROVIDER_PRESETS, testLlmConnection, type LlmConfig } from "./providers.js";

export interface RuntimeConfig {
  nodeId: string;
  workspaceDir: string;
  port: number;
  windowSize: number;
  tickIntervalMs: number;
  // @Antigravity, 20261118, [REFACTOR]: 使用泛用 LlmConfig（支持 provider 模板自动填充）
  // llm: {
  //   enabled: boolean;
  //   baseURL: string;
  //   apiKey: string;
  //   model: string;
  //   systemPrompt: string;
  //   maxSteps: number;
  // };
  llm: LlmConfig;
  // @Antigravity, 20261118, [FEAT]: 可选上下文窗口治理与 Token 预算配置
  budget?: ContextBudgetConfig;
  // @Antigravity, 20261118, [FEAT]: 扩展配置支持可选 enabled 开关
  // extensions: Array<{ module: string; options?: Record<string, unknown> }>;
  extensions: Array<{ module: string; enabled?: boolean; options?: Record<string, unknown> }>;
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
  // @Antigravity, 20261118, [FEAT]: 优雅停机标志与当前活跃回合追踪 Promise
  let shuttingDown = false;
  let activeTurnDone: Promise<void> | null = null;

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
    // @Antigravity, 20261118, [FEAT]: 透传上下文治理预算配置至 Maid
    budget: config.budget,
    getTools: () => tools,
  });
  if (overrides.maidExecute) {
    maid.execute = overrides.maidExecute;
  }

  /** generatePrompt -> Busy -> 女仆 -> endTurn -> Stock */
  async function triggerMaidTurn(incomingWake: BusEvent[], reason: string): Promise<void> {
    // @Antigravity, 20261118, [FEAT]: 停机或忙碌期间不再开启新回合, 仅压入 Stock 等待后续恢复或续接
    // if (crashed) return;
    // if (busy) {
    //   stock.push(...incomingWake);
    //   return;
    // }
    if (crashed) return;
    // @Antigravity, 20261119, [FIX]: 仅在 llm.enabled 为 true 时才从 Stock 取出事件, 避免禁用 LLM 时误吞事件
    // if (busy || shuttingDown) {
    //   stock.push(...incomingWake);
    //   return;
    // }
    //
    // const batch = [...stock.splice(0), ...incomingWake];
    // if (batch.length === 0 || !config.llm.enabled) return;
    if (busy || shuttingDown || !config.llm.enabled) {
      stock.push(...incomingWake);
      return;
    }

    const batch = [...stock.splice(0), ...incomingWake];
    if (batch.length === 0) return;

    busy = true;
    let resolveTurn!: () => void;
    activeTurnDone = new Promise<void>((r) => {
      resolveTurn = r;
    });
    try {
      const diary = existsSync(diaryPath) ? await readFile(diaryPath, "utf-8") : undefined;
      // @Antigravity, 20261118, [FEAT]: 向 maid.consume 注入已挂载扩展感知目录 (Manifests)
      // const consumedPrompt = maid.consume(eventsWindow, batch, { diary, triggerReason: reason });
      const consumedPrompt = maid.consume(eventsWindow, batch, {
        diary,
        triggerReason: reason,
        extensions: participants.map((p) => ({ id: p.id, manifest: p.manifest })),
      });
      if (!consumedPrompt || !maid.execute) return;

      const turnResult = await maid.execute(consumedPrompt, bus);
      for (const rawEvt of maid.produce(turnResult)) {
        await recordToLedger(rawEvt);
      }
    } catch (llmErr) {
      await handleFatalCrash("MAID_TURN", llmErr, { triggerReason: reason, pendingBatch: batch });
    } finally {
      busy = false;
      activeTurnDone = null;
      resolveTurn();
    }

    if (stock.length > 0 && !crashed && !shuttingDown) {
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
    // @Antigravity, 20261118, [FIX]: 支持 enabled 开关与基于 process.cwd() 的相对路径扩展加载
    // try {
    //   const mod = await jiti.import<{ default?: AgentExtension }>(ext.module);
    //   if (!mod.default) throw new Error(`Extension [${ext.module}] missing default export`);
    //   await mod.default(bus, ext.options);
    // } catch (bootErr) {
    //   await handleFatalCrash("BOOT", bootErr, { extensionModule: ext.module });
    // }
    if (ext.enabled === false) continue;
    try {
      const moduleSpec = ext.module.startsWith(".") ? resolve(process.cwd(), ext.module) : ext.module;
      const mod = await jiti.import<{ default?: AgentExtension }>(moduleSpec);
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
  // @Antigravity, 20261118, [FEAT]: 增加模型提供商预设列表与连通性测试接口
  app.get("/llm/providers", (c) =>
    c.json({
      ok: true,
      providers: Object.values(PROVIDER_PRESETS),
    })
  );
  app.post("/llm/test", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await testLlmConnection({
      provider: body.provider ?? config.llm.provider,
      baseURL: body.baseURL ?? config.llm.baseURL,
      apiKey: body.apiKey ?? config.llm.apiKey,
      model: body.model ?? config.llm.model,
    });
    return c.json(result, result.ok ? 200 : 400);
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
    // @Antigravity, 20261118, [FEAT]: 暴露优雅停机句柄, 等待当前 busy 回合 END_TURN 落盘后再退出
    shutdown: async () => {
      shuttingDown = true;
      if (activeTurnDone) {
        await activeTurnDone;
      }
    },
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
        // @Antigravity, 20261118, [REFACTOR]: 支持 LLM_PROVIDER 并由提供商预设自动填充默认 baseURL 与 model
        // baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
        // apiKey: process.env.LLM_API_KEY || "",
        // model: process.env.LLM_MODEL || "deepseek-chat",
        provider: process.env.LLM_PROVIDER || "",
        baseURL: process.env.LLM_BASE_URL || "",
        apiKey: process.env.LLM_API_KEY || "",
        model: process.env.LLM_MODEL || "",
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
  // @Antigravity, 20261118, [FEAT]: 监听 SIGINT / SIGTERM 实现安全优雅停机
  // if (config.tickIntervalMs > 0) {
  //   setInterval(() => runtime.bus.tick("TIMER_TICK"), config.tickIntervalMs);
  // }
  // serve({ fetch: runtime.app.fetch, hostname: "127.0.0.1", port: config.port });
  const tickTimer =
    config.tickIntervalMs > 0
      ? setInterval(() => runtime.bus.tick("TIMER_TICK"), config.tickIntervalMs)
      : null;
  const server = serve({ fetch: runtime.app.fetch, hostname: "127.0.0.1", port: config.port });

  let exiting = false;
  const gracefulShutdown = async (signal: string) => {
    if (exiting) return;
    exiting = true;
    console.log(`\n[${config.nodeId}] 收到 ${signal}, 等待当前回合结算后安全退出...`);
    if (tickTimer) clearInterval(tickTimer);
    await runtime.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  console.log(`[${config.nodeId}] Ready -> http://127.0.0.1:${config.port}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrap();
}

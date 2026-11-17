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
import { writeCrashReportSync } from "./crash.js";

async function bootstrap() {
  const { config } = await loadConfig({
    name: "agent",
    defaults: {
      nodeId: process.env.AGENT_NODE_ID || "leadership.center",
      workspaceDir: "./workspace",
      port: Number(process.env.AGENT_PORT || 3100),
      windowSize: 40,
      tickIntervalMs: 0,
      exitOnCrash: true, // Fast-Fail 开关：崩溃广播完 CRASH_REPORT 后直接退出进程
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
  const diaryPath = join(workspaceDir, "DIARY.md");

  const eventsWindow: BusEvent[] = [];
  const stock: BusEvent[] = [];
  let busy = false;
  let crashed = false;

  const tools: Record<string, Tool> = {};
  const participants: BusParticipant<any, any>[] = [];

  /** 广播崩溃报告给外部拓展（如 Redis 桥接器），随后立即 Fast-Fail */
async function handleFatalCrash(
    stage: CrashReport["stage"],
    error: unknown,
    contextSnapshot?: unknown
  ): Promise<never> {
    crashed = true;

    // 1. 独立旁路落盘，绝不污染 events.jsonl
    const report = dumpCrashReportSync({
      nodeId: config.nodeId,
      workspaceDir,
      stage,
      error,
      contextSnapshot,
    });

    // 2. 能广播的话看情况：给旁路 crashHandlers 最多 1.5 秒尽力外发，超时/报错直接放行
    if (crashHandlers.length > 0) {
      await Promise.race([
        Promise.allSettled(crashHandlers.map((fn) => Promise.resolve().then(() => fn(report)))),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }

    // 3. 干脆利落 Fast-Fail 退出
    process.exit(1);
  }
    throw error instanceof Error ? error : new Error(String(error));
  }

  // 全局未捕获异常兜底：零静默，直接写 CRASH_REPORT 并退出
  process.on("uncaughtException", (err) => {
    writeCrashReportSync({ nodeId: config.nodeId, workspaceDir, stage: "UNCAUGHT", error: err });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    writeCrashReportSync({ nodeId: config.nodeId, workspaceDir, stage: "UNCAUGHT", error: reason });
    process.exit(1);
  });

  // 1. 启动恢复：任何一行 events.jsonl 损坏立即 Fast-Fail，绝不静默跳过！
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
        await handleFatalCrash("BOOT", err, [], {
          reason: `events.jsonl 第 ${idx + 1} 行数据损坏或 Schema 不匹配`,
          corruptedLine: lines[idx],
        });
      }
    }

    eventsWindow.push(...allParsed.slice(-config.windowSize));
    for (const evt of allParsed) {
      const isExternalForMe =
        evt.source !== config.nodeId &&
        (evt.target === config.nodeId || evt.target === "*") &&
        evt.type !== "CRASH_REPORT";
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
      // Zod 校验不过直接生成 CRASH_REPORT 并 Fast-Fail 抛错
      await handleFatalCrash("INGEST_ZOD", parsed.error, [], { invalidRawInput: raw });
    }

    const event = parsed.data;
    await appendFile(eventsLogPath, JSON.stringify(event) + "\n", "utf-8");
    eventsWindow.push(event);
    if (eventsWindow.length > config.windowSize) eventsWindow.shift();
    return event;
  }

  const maid = createMaidParticipant({
    nodeId: config.nodeId,
    llm: config.llm,
    getTools: () => tools,
  });

  /** 右半部闭环：generatePrompt -> Busy -> 女仆 -> endTurn -> Stock */
  async function triggerMaidTurn(incomingWake: BusEvent[], reason: string): Promise<void> {
    if (crashed) throw new Error(`[${config.nodeId}] Node is in CRASHED state.`);
    if (busy) {
      stock.push(...incomingWake);
      return;
    }

    const batch = [...stock.splice(0), ...incomingWake];
    if (batch.length === 0 || !config.llm.enabled || !config.llm.apiKey) return;

    busy = true;
    try {
      const diary = existsSync(diaryPath) ? await readFile(diaryPath, "utf-8") : undefined;
      const consumedPrompt = maid.consume(eventsWindow, batch, { diary, triggerReason: reason });
      if (!consumedPrompt || !maid.execute) return;

      const turnResult = await maid.execute(consumedPrompt, bus);

      for (const rawEvt of maid.produce(turnResult)) {
        await recordToLedger(rawEvt);
      }
    } catch (err) {
      // 女仆推理或工具执行崩溃：不静默塞回 Stock，直接产出 CRASH_REPORT 广播并 Fast-Fail！
      await handleFatalCrash("MAID_TURN", err, batch, { triggerReason: reason });
    } finally {
      busy = false;
    }

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
      if (crashed) throw new Error(`[${config.nodeId}] Node is CRASHED, rejecting ingest.`);

      // 1. Zod 校验：如果外部或拓展传入的事件格式本身不合法，直接抛错拒绝（不进账本，也不杀进程）
      const parsed = BusEventSchema.safeParse({
        id: `EVT-${Date.now()}-${randomUUID().slice(0, 5)}`,
        ts: new Date().toISOString(),
        ...raw,
      });
      if (!parsed.success) {
        const errMsg = `Invalid Event Schema from [${raw.source}]: ${parsed.error.message}`;
        console.error(`⚠️ [EVENT_REJECTED] ${errMsg}`);
        throw new Error(errMsg);
      }

      // 2. 账本写入：如果连本地磁盘 events.jsonl 都写不进去，属于【底层报错】，直接 Fast-Fail！
      const event = parsed.data;
      try {
        await appendFile(eventsLogPath, JSON.stringify(event) + "\n", "utf-8");
      } catch (ioErr) {
        await handleFatalCrash("BOOT", ioErr, { reason: "Failed to append to events.jsonl", event });
      }

      eventsWindow.push(event);
      if (eventsWindow.length > config.windowSize) eventsWindow.shift();

      // 3. 拓展参与者消费与执行
      for (const p of participants) {
        const input = p.consume(eventsWindow, [event]);
        if (input !== null && p.execute) {
          try {
            const out = await p.execute(input, bus);
            for (const produced of p.produce(out)) {
              await bus.ingest(produced);
            }
          } catch (taskErr: any) {
            // 【事件报错】：拓展执行具体业务失败（非底层引擎崩溃）
            // 零静默打印日志，并将其包装为高优错误事件注入主事件流 (wake: true)，唤醒女仆处理或上报！
            console.error(`❗ [EVENT_ERROR][${p.id}] 拓展执行失败，已转化为错误事件注入总线:`, taskErr);
            if (event.type !== "EXTENSION_TASK_ERROR") {
              await bus.ingest({
                source: p.id,
                target: config.nodeId,
                type: "EXTENSION_TASK_ERROR",
                prompt: `[拓展任务报错] 拓展 "${p.id}" 在处理事件 "${event.type}" (${event.id}) 时异常: ${taskErr?.message ?? String(taskErr)}`,
                wake: true,
                responseMode: "respond",
                outbound: true,
                payload: {
                  failedParticipant: p.id,
                  triggerEventId: event.id,
                  triggerEventType: event.type,
                  error: taskErr?.message ?? String(taskErr),
                  stack: taskErr?.stack,
                },
              });
            }
          }
        }
      }

      // 4. 菱形 Flag 分流：走 Wake 或进 Stock
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
    if (!mod.default) {
      await handleFatalCrash("BOOT", new Error(`Extension [${ext.module}] missing default export`));
    }
    await mod.default(bus, ext.options);
  }

  if (config.tickIntervalMs > 0) {
    setInterval(() => bus.tick("TIMER_TICK"), config.tickIntervalMs);
  }

  const app = new Hono();
  app.get("/status", (c) =>
    c.json({ nodeId: config.nodeId, crashed, busy, stockCount: stock.length, stock, recentWindow: eventsWindow.slice(-10) })
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

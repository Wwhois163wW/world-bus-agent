import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createHooks } from "hookable";
import { createJiti } from "jiti";
import { loadConfig } from "c12";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { ToolLoopAgent, stepCountIs, type Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  WorldEventSchema,
  type AgentConfig,
  type AgentContext,
  type AgentExtension,
  type RuntimeHooks,
  type WorldEvent,
} from "./types.js";

async function main() {
  // 1. 使用 c12 加载 agent.config.ts / .json 及环境变量覆盖
  const { config } = await loadConfig<AgentConfig>({
    name: "agent",
    defaults: {
      nodeId: process.env.AGENT_NODE_ID || "node.local",
      workspaceDir: "./workspace",
      port: Number(process.env.AGENT_PORT || 3100),
      windowSize: 30,
      llm: {
        enabled: Boolean(process.env.LLM_API_KEY),
        baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
        apiKey: process.env.LLM_API_KEY || "",
        model: process.env.LLM_MODEL || "deepseek-chat",
        systemPrompt: "You are an event-driven agent core. Analyze the event window and invoke registered tools when needed.",
        wakeOnTypes: ["MANUAL_WAKE"],
        maxSteps: 5,
      },
      extensions: [],
    },
  });

  const workspaceDir = resolve(config.workspaceDir);
  await mkdir(workspaceDir, { recursive: true });

  // 2. 初始化 Hookable 总线与内存状态（运行态仅 standby <-> active）
  const hooks = createHooks<RuntimeHooks>();
  const tools: Record<string, Tool> = {};
  const slidingWindow: WorldEvent[] = [];
  const nodePresence = new Map<string, string>();
  let agentState: "STANDBY" | "ACTIVE" = "STANDBY";

  const ctx: AgentContext = {
    nodeId: config.nodeId,
    workspaceDir,
    hooks,
    registerTool: (name, toolDef) => {
      tools[name] = toolDef;
    },
    getWindow: () => [...slidingWindow],
    emit: async (partial, meta = {}) => {
      const event = WorldEventSchema.parse({
        id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
        ts: new Date().toISOString(),
        source: partial.source ?? config.nodeId,
        ...partial,
      });

      // 本地 workspace 账本持久化
      await appendFile(join(workspaceDir, "events.jsonl"), JSON.stringify(event) + "\n");

      // SIGNAL（如心跳）仅刷新在线表，不进入 LLM 滑动窗口
      if (event.category === "SIGNAL") {
        nodePresence.set(event.source, event.ts);
      } else {
        slidingWindow.push(event);
        if (slidingWindow.length > config.windowSize) slidingWindow.shift();
      }

      // 广播给所有挂载的拓展（Hand 与桥接器）
      await hooks.callHook("bus:event", event, meta);
      return event;
    },
  };

  // 3. 使用 jiti 动态加载独立拓展仓库
  const jiti = createJiti(import.meta.url);
  for (const extEntry of config.extensions) {
    const mod = await jiti.import<{ default?: AgentExtension; extension?: AgentExtension }>(
      extEntry.module
    );
    const fn = mod.default ?? mod.extension;
    if (!fn) throw new Error(`拓展模块 [${extEntry.module}] 未导出有效的插件函数`);
    await fn(ctx, extEntry.options);
  }

  // 4. 挂载 LLM 大脑算子（平时 STANDBY 零消耗，命中唤醒条件时瞬时激活调用 Tool）
  hooks.hook("bus:event", async (event) => {
    if (!config.llm.enabled || !config.llm.apiKey) return;
    const isForMe = event.target === config.nodeId || event.target === "*";
    const shouldWake = event.wake_brain || config.llm.wakeOnTypes.includes(event.type);
    if (!isForMe || !shouldWake) return;

    agentState = "ACTIVE";
    try {
      const provider = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: config.llm.baseURL,
        apiKey: config.llm.apiKey,
      });

      const brain = new ToolLoopAgent({
        model: provider(config.llm.model),
        instructions: config.llm.systemPrompt,
        tools,
        stopWhen: stepCountIs(config.llm.maxSteps ?? 5),
      });

      const causalSlice = event.correlation_id
        ? slidingWindow.filter((e) => e.correlation_id === event.correlation_id)
        : slidingWindow.slice(-15);

      await brain.generate({
        prompt: JSON.stringify({
          node_id: config.nodeId,
          online_peers: Object.fromEntries(nodePresence),
          trigger_event: event,
          context_window: causalSlice,
        }),
      });
    } finally {
      agentState = "STANDBY";
    }
  });

  // 5. Hono Localhost 控制面（状态查看、外部脚本注入、主动唤醒、热改 LLM 配置）
  const app = new Hono();

  app.get("/status", (c) =>
    c.json({
      nodeId: config.nodeId,
      state: agentState,
      registeredTools: Object.keys(tools),
      onlinePeers: Object.fromEntries(nodePresence),
      windowSize: slidingWindow.length,
      recentEvents: slidingWindow.slice(-10),
    })
  );

  app.post("/events", async (c) => {
    const body = await c.req.json();
    const event = await ctx.emit(body);
    return c.json({ ok: true, event }, 201);
  });

  app.post("/wake", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const event = await ctx.emit({
      category: "ACTION",
      type: body.type || "MANUAL_WAKE",
      target: body.target || config.nodeId,
      correlation_id: body.correlation_id ?? null,
      wake_brain: true,
      payload: body.payload ?? {},
    });
    return c.json({ ok: true, woken: event });
  });

  app.post("/config/llm", async (c) => {
    const patch = await c.req.json();
    Object.assign(config.llm, patch);
    return c.json({ ok: true, model: config.llm.model, baseURL: config.llm.baseURL, enabled: config.llm.enabled });
  });

  await hooks.callHook("agent:ready", ctx);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port });
  console.log(`[${config.nodeId}] Agent Ready (state: ${agentState}) -> http://127.0.0.1:${config.port}`);
}

main();

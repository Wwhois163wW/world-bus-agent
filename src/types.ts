import { z } from "zod";
import type { Hookable } from "hookable";
import type { Tool } from "ai";

/**
 * 事件 Schema (由拓展或 LLM 生产，经 Zod 校验后落盘 events.jsonl)
 * - wake: 对应流程图中的菱形 Flag (true 立即走 Wake，false 进 Stock)
 * - responseMode: 事件设计期决定的响应要求 (optional 可选回应 / respond 必须回应 / tool_required 必须调工具)
 */
export const WorldEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  source: z.string(),
  target: z.string().default("*"),
  type: z.string(),
  prompt: z.string(), // 事件携带的提示词描述（供 generatePrompt 直接拼装）
  wake: z.boolean().default(false),
  responseMode: z.enum(["optional", "respond", "tool_required"]).default("optional"),
  outbound: z.boolean().default(true),
  payload: z.record(z.unknown()).default({}),
});

export type WorldEvent = z.infer<typeof WorldEventSchema>;
export type EventInput = z.input<typeof WorldEventSchema>;

export interface AgentHooks {
  "agent:ready": (ctx: AgentContext) => Promise<void> | void;
  "bus:event": (event: WorldEvent, meta: { fromBridge?: boolean }) => Promise<void> | void;
  "agent:stop": () => Promise<void> | void;
}

export interface AgentContext {
  readonly nodeId: string;
  readonly workspaceDir: string;
  readonly hooks: Hookable<AgentHooks>;
  /** 注入事件：走 Event -> Zod -> events.jsonl -> eventsWindow & Flag */
  emit: (
    input: Omit<EventInput, "id" | "ts" | "source"> & { source?: string },
    meta?: { fromBridge?: boolean }
  ) => Promise<WorldEvent>;
  /** 触发旁路 Tick 脉冲：直接唤醒消化 Stock */
  tick: (reason?: string) => Promise<void>;
  /** 允许外部拓展追加自定义 Tool（内置原生工具已默认挂载） */
  registerTool: (name: string, toolDef: Tool) => void;
}

export type AgentExtension = (
  ctx: AgentContext,
  options?: Record<string, unknown>
) => Promise<void> | void;

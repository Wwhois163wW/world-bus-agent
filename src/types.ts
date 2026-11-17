import { z } from "zod";
import type { Hookable } from "hookable";
import type { Tool } from "ai";

/**
 * 传输无关、业务无关的世界总线事件原语
 * - OBSERVATION: 眼/手产生的客观事实（进入滑动窗口）
 * - ACTION: LLM 或人类发出的执行指令（进入滑动窗口）
 * - SIGNAL: 心跳或定时器脉冲（仅刷新在线状态，不污染 LLM 滑动窗口）
 */
export const WorldEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  category: z.enum(["OBSERVATION", "ACTION", "SIGNAL"]),
  type: z.string(),
  source: z.string(),
  target: z.string().default("*"),
  correlation_id: z.string().nullable().optional(),
  causation_id: z.string().nullable().optional(),
  outbound: z.boolean().default(true),
  wake_brain: z.boolean().default(false),
  payload: z.record(z.unknown()).default({}),
});

export type WorldEvent = z.infer<typeof WorldEventSchema>;
export type EmitInput = z.input<typeof WorldEventSchema>;

export interface RuntimeHooks {
  "agent:ready": (ctx: AgentContext) => Promise<void> | void;
  "bus:event": (event: WorldEvent, meta: { fromBridge?: boolean }) => Promise<void> | void;
  "agent:stop": () => Promise<void> | void;
}

export interface AgentContext {
  readonly nodeId: string;
  readonly workspaceDir: string;
  readonly hooks: Hookable<RuntimeHooks>;
  /** 注入事件至本地总线（自动追加写入 workspace/events.jsonl 并触发钩子） */
  emit: (
    event: Omit<EmitInput, "id" | "ts" | "source"> & { source?: string },
    meta?: { fromBridge?: boolean }
  ) => Promise<WorldEvent>;
  /** 外部拓展向 LLM 大脑注册可调用的 Vercel AI SDK Tool */
  registerTool: (name: string, toolDef: Tool) => void;
  /** 读取当前滑动窗口 */
  getWindow: () => ReadonlyArray<WorldEvent>;
}

/** 所有独立拓展仓库统一遵循的插件函数签名 */
export type AgentExtension = (
  ctx: AgentContext,
  options?: Record<string, unknown>
) => Promise<void> | void;

export interface AgentConfig {
  nodeId: string;
  workspaceDir: string;
  port: number;
  windowSize: number;
  llm: {
    enabled: boolean;
    baseURL: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    wakeOnTypes: string[];
    maxSteps?: number;
  };
  extensions: Array<{
    module: string;
    options?: Record<string, unknown>;
  }>;
}

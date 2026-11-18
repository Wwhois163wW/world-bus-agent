/**
 * @file src/types.ts
 * @description 核心事件总线 Schema, 参与者自描述契约 (ParticipantManifest) 与扩展接口定义
 */
import { z } from "zod";
import type { Tool } from "ai";
import type { CrashReport } from "./crash.js";

export const BusEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  source: z.string(),
  target: z.string().default("*"),
  type: z.string(),
  prompt: z.string(),
  wake: z.boolean().default(false),
  responseMode: z.enum(["optional", "respond", "tool_required"]).default("optional"),
  outbound: z.boolean().default(true),
  payload: z.record(z.unknown()).default({}),
});

export type BusEvent = z.infer<typeof BusEventSchema>;
export type RawBusEventInput = Omit<z.input<typeof BusEventSchema>, "id" | "ts">;

/**
 * 扩展参与者的自描述契约（供 Maid LLM 自动识别与感知）
 */
// @Antigravity, 20261118, [FEAT]: 新增 ParticipantManifest 扩展自描述契约并注入 extraContext.extensions
export interface ParticipantManifest {
  /** 扩展功能简述 */
  description: string;
  /** 该扩展监听/消费的事件契约（指导 LLM 如何通过 emit_event 触发它） */
  consumes?: Array<{
    type: string;
    description?: string;
    payloadSchema?: Record<string, string>;
  }>;
  /** 该扩展可能生产回注的事件契约（帮助 LLM 识别 eventsWindow 中的事件来源） */
  produces?: Array<{
    type: string;
    description?: string;
  }>;
}

/**
 * 任意拓展与 Agent LLM 自身插入事件总线时必须实现的【纯总线收发契约】
 * consume 与 produce 必须为无外部 I/O 副作用的纯函数转换
 */
// export interface BusParticipant<TConsumedInput = unknown, TProducedOutput = unknown> {
//   readonly id: string;
//   consume(
//     eventsWindow: ReadonlyArray<BusEvent>,
//     pendingBatch: ReadonlyArray<BusEvent>,
//     extraContext?: { diary?: string; triggerReason?: string }
//   ): TConsumedInput | null;
//   produce(output: TProducedOutput): RawBusEventInput[];
//   execute?(input: TConsumedInput, bus: WorldBusContext): Promise<TProducedOutput>;
// }
export interface BusParticipant<TConsumedInput = unknown, TProducedOutput = unknown> {
  readonly id: string;
  /** 可选：向 Maid 暴露的扩展感知元数据 */
  readonly manifest?: ParticipantManifest;
  consume(
    eventsWindow: ReadonlyArray<BusEvent>,
    pendingBatch: ReadonlyArray<BusEvent>,
    extraContext?: {
      diary?: string;
      triggerReason?: string;
      extensions?: ReadonlyArray<{ id: string; manifest?: ParticipantManifest }>;
    }
  ): TConsumedInput | null;
  produce(output: TProducedOutput): RawBusEventInput[];
  execute?(input: TConsumedInput, bus: WorldBusContext): Promise<TProducedOutput>;
}

export interface WorldBusContext {
  readonly nodeId: string;
  readonly workspaceDir: string;
  ingest: (raw: RawBusEventInput) => Promise<BusEvent>;
  tick: (reason?: string) => Promise<void>;
  registerParticipant: (participant: BusParticipant<any, any>) => void;
  registerTool: (name: string, toolDef: Tool) => void;
  onCrash: (handler: (report: CrashReport) => Promise<void> | void) => void;
}

export type AgentExtension = (
  bus: WorldBusContext,
  options?: Record<string, unknown>
) => Promise<void> | void;

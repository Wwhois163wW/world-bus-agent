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
 * 任意拓展与 Agent LLM 自身插入事件总线时必须实现的【纯总线收发契约】
 * consume 与 produce 必须为无外部 I/O 副作用的纯函数转换
 */
export interface BusParticipant<TConsumedInput = unknown, TProducedOutput = unknown> {
  readonly id: string;
  consume(
    eventsWindow: ReadonlyArray<BusEvent>,
    pendingBatch: ReadonlyArray<BusEvent>,
    extraContext?: { diary?: string; triggerReason?: string }
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

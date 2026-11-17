import { z } from "zod";
import type { Tool } from "ai";
import type { CrashReport } from "./crash.js";

/** 粉色图左上角 Zod 校验的标准事件信封 */
export const BusEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  source: z.string(),
  target: z.string().default("*"),
  type: z.string(),
  /** 生产者在设计期包装好的提示词描述（供 LLM 消费阅读） */
  prompt: z.string(),
  /** 生产者在设计期写死的菱形 Flag：true 走 Wake 立即唤醒，false 进 Stock 攒批 */
  wake: z.boolean().default(false),
  /** 事件响应级别约束 */
  responseMode: z.enum(["optional", "respond", "tool_required"]).default("optional"),
  /** 是否允许跨机桥接拓展外发 */
  outbound: z.boolean().default(true),
  /** 结构化数据载荷（供确定性拓展消费或记录结算元数据） */
  payload: z.record(z.unknown()).default({}),
});

export type BusEvent = z.infer<typeof BusEventSchema>;
export type RawBusEventInput = Omit<z.input<typeof BusEventSchema>, "id" | "ts">;

/**
 * 任意拓展（以及 Agent LLM 自身）插入事件总线时必须实现的【纯总线收发契约】
 * 约束：consume 与 produce 必须是纯转换动作，严禁包含任何外部 I/O 副作用！
 */
export interface BusParticipant<TConsumedInput = unknown, TProducedOutput = unknown> {
  readonly id: string;

  /**
   * 【消费动作 Consume】（无外部副作用）
   * 从总线的 eventsWindow 与待办批次中只读投影出本模块需要的输入。
   * 若当前事件与本模块无关，返回 null。
   */
  consume(
    eventsWindow: ReadonlyArray<BusEvent>,
    pendingBatch: ReadonlyArray<BusEvent>,
    extraContext?: { diary?: string; triggerReason?: string }
  ): TConsumedInput | null;

  /**
   * 【生产动作 Produce】（无外部副作用）
   * 将模块内部执行完的结果，纯函数式地打包为标准事件数组，交由总线送入左上角 Event -> Zod 入口。
   */
  produce(output: TProducedOutput): RawBusEventInput[];

  /**
   * 模块内部执行器（外部拓展的业务动作或 LLM 的 ToolLoop 推理在此发生，与纯总线收发解耦）
   */
  execute?(input: TConsumedInput, bus: WorldBusContext): Promise<TProducedOutput>;
}

export interface WorldBusContext {
  readonly nodeId: string;
  readonly workspaceDir: string;
  /** 将生产出的原始事件送入左上角 Event -> Zod -> events.jsonl 管道 */
  ingest: (raw: RawBusEventInput, meta?: { fromBridge?: boolean }) => Promise<BusEvent>;
  /** 旁路 Tick 脉冲：直接触发 Stock 排空 */
  tick: (reason?: string) => Promise<void>;
  /** 注册一个实现好 consume/produce 的总线参与者（拓展） */
  registerParticipant: (participant: BusParticipant<any, any>) => void;
  /** 向女仆追加注册原生或自定义工具 */
  registerTool: (name: string, toolDef: Tool) => void;
  /** 可选旁路崩溃钩子：能广播就尽力广播，不走主事件流，超时或失败直接忽略 */
  onCrash: (handler: (report: CrashReport) => Promise<void> | void) => void;
}

export type AgentExtension = (
  bus: WorldBusContext,
  options?: Record<string, unknown>
) => Promise<void> | void;

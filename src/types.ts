/** 纯粹的本地事件认知分类，与外部传输协议无关 */
export type EventKind = "OBSERVATION" | "ACTION" | "HEARTBEAT";

/** 传输无关的统一世界总线事件信封 */
export interface WorldEvent<TPayload = Record<string, unknown>> {
  envelope_version: "1.0";
  msg_id: string;
  kind: EventKind;
  msg_type: string;
  timestamp: string;
  source_node: string;
  target_node: string;
  order_id?: string | null;
  correlation_id?: string | null;
  /** 是否允许通信桥接插件外发至外部总线，默认 true */
  outbound?: boolean;
  /** 若为 true（或 kind === "HEARTBEAT"），仅触发状态更新而不挤占 LLM 滑动窗口 */
  ephemeral?: boolean;
  /** 显式请求唤醒 LLM 大脑 */
  wake_brain?: boolean;
  payload: TPayload;
}

export interface EmitOptions {
  /** 标记事件是否来自外部桥接插件，防止出站桥接器重复转发造成回环 */
  fromExternalBridge?: boolean;
}

export interface ExtensionContext {
  readonly nodeId: string;
  readonly workspaceDir: string;
  emit: (
    event: Omit<WorldEvent, "envelope_version" | "msg_id" | "timestamp" | "source_node">,
    options?: EmitOptions
  ) => Promise<WorldEvent>;
  onRawEvent: (listener: (event: WorldEvent, meta: Required<EmitOptions>) => void) => () => void;
  getRecentWindow: () => ReadonlyArray<WorldEvent>;
  getNodePresence: () => ReadonlyMap<string, WorldEvent>;
  log: (level: "INFO" | "WARN" | "ERROR", message: string, meta?: unknown) => void;
}

export interface LlmCallableActionSpec {
  actionType: string;
  defaultTargetNode: string;
  description: string;
  payloadJsonSchema: Record<string, unknown>;
}

export interface AgentExtension {
  readonly name: string;
  readonly version?: string;
  readonly subscriptions?: string[];
  readonly llmActionSpecs?: LlmCallableActionSpec[];
  onInit?(ctx: ExtensionContext): Promise<void>;
  onEvent?(event: WorldEvent, ctx: ExtensionContext): Promise<void>;
  onDestroy?(): Promise<void>;
}

export type ExtensionFactory = (
  options: Record<string, unknown>
) => AgentExtension | Promise<AgentExtension>;

export interface BrainConfig {
  enabled: boolean;
  systemPrompt: string;
  wakeOnTypes: string[];
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    temperature?: number;
  };
}

export interface AgentCoreConfig {
  nodeId: string;
  workspaceDir: string;
  windowSize?: number;
  controlServer?: {
    enabled: boolean;
    host?: string;
    port?: number;
  };
  brain: BrainConfig;
  extensions?: Array<{
    module: string;
    enabled?: boolean;
    options?: Record<string, unknown>;
  }>;
}

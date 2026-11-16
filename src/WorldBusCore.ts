import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import OpenAI from "openai";

export interface LocalWorldEvent<TPayload = Record<string, unknown>> {
  envelope_version: "1.0";
  msg_id: string;
  stream: "stream:orders" | "stream:order_events" | "stream:reports" | "stream:heartbeat";
  msg_type: string;
  timestamp: string;
  source_node: string;
  target_node: string;
  order_id?: string | null;
  correlation_id?: string | null;
  /** 标记是否允许桥接插件转发至外部总线（默认 true，设为 false 则纯本地消化） */
  outbound?: boolean;
  wake_brain?: boolean;
  payload: TPayload;
}

export interface ExtensionContext {
  readonly nodeId: string;
  readonly workspaceDir: string;
  /** 注入事件到本地世界总线（若挂载了 Redis 桥接插件且 outbound!==false，会自动外发） */
  emit: (
    event: Omit<LocalWorldEvent, "envelope_version" | "msg_id" | "timestamp" | "source_node">,
    options?: { fromExternalBridge?: boolean }
  ) => Promise<LocalWorldEvent>;
  /** 监听总线上的原始事件流（供 Redis 桥接插件抓取外发事件） */
  onRawEvent: (listener: (event: LocalWorldEvent, meta: { fromExternalBridge: boolean }) => void) => void;
  getRecentWindow: () => ReadonlyArray<LocalWorldEvent>;
}

export interface AgentExtension {
  readonly name: string;
  readonly subscriptions?: string[];
  onInit?(ctx: ExtensionContext): Promise<void>;
  onEvent?(event: LocalWorldEvent, ctx: ExtensionContext): Promise<void>;
  onDestroy?(): Promise<void>;
}

/**
 * 独立、零外部中间件依赖的空心 Agent 核心
 * 即使不连接 Redis、不与其他 Agent 通信，单机依然完整运转
 */
export class WorldBusCore {
  private readonly bus = new EventEmitter();
  private readonly extensions: AgentExtension[] = [];
  private readonly handlers = new Map<string, AgentExtension[]>();
  private readonly window: LocalWorldEvent[] = [];

  constructor(
    private readonly config: {
      nodeId: string;
      workspaceDir: string;
      windowSize?: number;
      llm?: { enabled: boolean; baseURL: string; apiKey: string; model: string; systemPrompt: string; wakeOnTypes: string[] };
    }
  ) {}

  public use(ext: AgentExtension): this {
    this.extensions.push(ext);
    for (const type of ext.subscriptions ?? []) {
      const list = this.handlers.get(type) ?? [];
      list.push(ext);
      this.handlers.set(type, list);
    }
    return this;
  }

  public emit = async (
    partial: Omit<LocalWorldEvent, "envelope_version" | "msg_id" | "timestamp" | "source_node">,
    options: { fromExternalBridge?: boolean } = {}
  ): Promise<LocalWorldEvent> => {
    const event: LocalWorldEvent = {
      envelope_version: "1.0",
      msg_id: `MSG-${Date.now()}-${randomBytes(3).toString("hex")}`,
      timestamp: new Date().toISOString(),
      source_node: this.config.nodeId,
      outbound: true,
      ...partial,
    };

    // 1. 本地 workspace 持久化追加（断网/无 Redis 时所有事件依然有本地账本）
    const logPath = join(this.config.workspaceDir, "events.jsonl");
    await appendFile(logPath, JSON.stringify(event) + "\n", "utf-8");

    // 2. 通知底层监听器（如 ext-bridge-redis 捕获本地产生的事件并推向远端 Redis）
    this.bus.emit("raw_event", event, { fromExternalBridge: Boolean(options.fromExternalBridge) });

    // 3. 维护滑动窗口 & 路由至本地订阅的 Hand
    await this.dispatchLocally(event);
    return event;
  };

  private createContext(): ExtensionContext {
    return {
      nodeId: this.config.nodeId,
      workspaceDir: this.config.workspaceDir,
      emit: this.emit,
      onRawEvent: (listener) => {
        this.bus.on("raw_event", listener);
      },
      getRecentWindow: () => [...this.window],
    };
  }

  public async boot(): Promise<void> {
    await mkdir(this.config.workspaceDir, { recursive: true });
    const ctx = this.createContext();

    for (const ext of this.extensions) {
      if (ext.onInit) await ext.onInit(ctx);
    }
    console.log(`[${this.config.nodeId}] 独立内核启动完成 (已加载 ${this.extensions.length} 个拓展)`);
  }

  private async dispatchLocally(event: LocalWorldEvent): Promise<void> {
    if (event.stream !== "stream:heartbeat") {
      this.window.push(event);
      if (this.window.length > (this.config.windowSize ?? 30)) {
        this.window.shift();
      }
    }

    // 指向本节点或广播的事件，交由本地挂载的 Hand 执行
    const isForMe =
      event.target_node === this.config.nodeId || event.target_node.startsWith("broadcast.");
    if (!isForMe) return;

    const ctx = this.createContext();
    for (const handler of this.handlers.get(event.msg_type) ?? []) {
      if (handler.onEvent) await handler.onEvent(event, ctx);
    }

    // 若启用了 LLM 且命中唤醒白名单，在此调用 OpenAI 协议算子并回注动作...
  }
}

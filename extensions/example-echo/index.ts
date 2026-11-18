/**
 * @file extensions/example-echo/index.ts
 * @description 示例扩展插件：注册 echo_ping 工具与 PING_TEST/PONG_RESULT 总线参与者
 */
// @Antigravity, 20261118, [REFACTOR]: 按新版 AgentExtension + BusParticipant 契约重写（原旧版实现完整注释保留于下方）
// import type { AgentExtension, ExtensionFactory } from "../../src/types.js";
//
// export const createExtension: ExtensionFactory = (options): AgentExtension => {
//   const greeting = String(options.greeting || "Echo extension ready");
//
//   return {
//     name: "example-echo",
//     version: "0.1.0",
//     subscriptions: ["PING_TEST", "MANUAL_WAKE"],
//     llmActionSpecs: [
//       {
//         actionType: "PING_TEST",
//         targetStream: "stream:order_events",
//         defaultTargetNode: "leadership.center",
//         description: "发送一条测试回响事件以验证总线连通性",
//         payloadJsonSchema: {
//           type: "object",
//           required: ["message"],
//           properties: { message: { type: "string" } },
//           additionalProperties: false,
//         },
//       },
//     ],
//     async onInit(ctx) {
//       ctx.log("INFO", `[example-echo] 初始化完成: ${greeting}`);
//     },
//     async onEvent(event, ctx) {
//       ctx.log("INFO", `[example-echo] 响应事件 ${event.msg_type}`, event.payload);
//       await ctx.emit({
//         stream: "stream:order_events",
//         msg_type: "PONG_RESULT",
//         target_node: event.source_node,
//         correlation_id: event.msg_id,
//         outbound: false,
//         payload: { echoed_from: event.msg_id, note: "本地拓展响应成功" },
//       });
//     },
//   };
// };
//
// export default createExtension;

import {
  tool,
  z,
  type AgentExtension,
  type BusEvent,
  type RawBusEventInput,
} from "../../src/index.js";

interface EchoExecutionResult {
  greeting: string;
  replyText: string;
  triggerEvent: BusEvent;
}

export const exampleEchoExtension: AgentExtension = (bus, options = {}) => {
  const greeting = String(options.greeting ?? "Echo hand is armed and listening.");
  const prefix = String(options.prefix ?? "ECHO");

  // 1. 向女仆注册扩展工具（遵循 ai@6 inputSchema 规范）
  bus.registerTool(
    "echo_ping",
    tool({
      description: "返回示例扩展的回响信息, 用于验证扩展工具挂载是否正常",
      inputSchema: z.object({
        message: z.string().describe("要回显的消息内容"),
      }),
      execute: async ({ message }) => ({
        ok: true,
        nodeId: bus.nodeId,
        greeting,
        echoed: message,
      }),
    })
  );

  // 2. 注册具备自描述 Manifest 的纯收发分离 BusParticipant
  // @Antigravity, 20261118, [FEAT]: 补充 ParticipantManifest 自描述契约与 prefix/target 匹配
  bus.registerParticipant({
    id: "ext.example.echo",
    manifest: {
      description: "示例回显扩展：接收 PING_TEST 事件并自动向总线回注一条 PONG_RESULT 事件",
      consumes: [
        {
          type: "PING_TEST",
          description: "触发回显测试",
          payloadSchema: { message: "string (可选, 要回显的内容)" },
        },
      ],
      produces: [
        {
          type: "PONG_RESULT",
          description: "回显结果事件",
        },
      ],
    },

    consume(_eventsWindow, pendingBatch): BusEvent | null {
      const hit = pendingBatch.find(
        (e) =>
          e.type === "PING_TEST"
          && (e.target === "ext.example.echo" || e.target === bus.nodeId || e.target === "*")
      );
      return hit ?? null;
    },

    async execute(event: BusEvent): Promise<EchoExecutionResult> {
      if (event.payload?.simulateError === true) {
        throw new Error("Simulated extension failure on PING_TEST");
      }
      const msg = String(event.payload.message ?? event.prompt);
      return {
        greeting,
        replyText: `[${prefix}] ${msg}`,
        triggerEvent: event,
      };
    },

    produce(result: EchoExecutionResult): RawBusEventInput[] {
      return [
        {
          source: "ext.example.echo",
          target: result.triggerEvent.source || bus.nodeId,
          type: "PONG_RESULT",
          prompt: `[example-echo] ${result.greeting} -> ${result.replyText} (echoed ${result.triggerEvent.id})`,
          wake: false,
          responseMode: "optional",
          outbound: false,
          payload: {
            echoedFrom: result.triggerEvent.id,
            reply: result.replyText,
            originalPayload: result.triggerEvent.payload,
          },
        },
      ];
    },
  });
};

export default exampleEchoExtension;

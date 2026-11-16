import type { AgentExtension, ExtensionFactory } from "../../src/types.js";

export const createExtension: ExtensionFactory = (options): AgentExtension => {
  const greeting = String(options.greeting || "Echo extension ready");

  return {
    name: "example-echo",
    version: "0.1.0",
    subscriptions: ["PING_TEST", "MANUAL_WAKE"],
    llmActionSpecs: [
      {
        actionType: "PING_TEST",
        targetStream: "stream:order_events",
        defaultTargetNode: "leadership.center",
        description: "发送一条测试回响事件以验证总线连通性",
        payloadJsonSchema: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    async onInit(ctx) {
      ctx.log("INFO", `[example-echo] 初始化完成: ${greeting}`);
    },
    async onEvent(event, ctx) {
      ctx.log("INFO", `[example-echo] 响应事件 ${event.msg_type}`, event.payload);
      await ctx.emit({
        stream: "stream:order_events",
        msg_type: "PONG_RESULT",
        target_node: event.source_node,
        correlation_id: event.msg_id,
        outbound: false,
        payload: { echoed_from: event.msg_id, note: "本地拓展响应成功" },
      });
    },
  };
};

export default createExtension;

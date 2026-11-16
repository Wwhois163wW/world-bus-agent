import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WorldBusCore } from "./WorldBusCore.js";

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

export class LocalControlServer {
  private server?: Server;

  constructor(
    private readonly core: WorldBusCore,
    private readonly host = "127.0.0.1",
    private readonly port = 3100
  ) {}

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
        try {
          // 1. 状态与滑动窗口快照查询
          if (req.method === "GET" && (url.pathname === "/status" || url.pathname === "/health")) {
            return sendJson(res, 200, this.core.getStatusSnapshot());
          }

          // 2. 本地外部脚本（如 Python watchdog / cron tick）直接注入事件
          if (req.method === "POST" && url.pathname === "/events") {
            const body = await readJsonBody(req);
            const emitted = await this.core.emit({
              stream: (body.stream as string) || "stream:order_events",
              msg_type: String(body.msg_type || "EXTERNAL_OBSERVATION"),
              target_node: String(body.target_node || this.core.getStatusSnapshot().nodeId),
              order_id: (body.order_id as string) ?? null,
              correlation_id: (body.correlation_id as string) ?? null,
              outbound: body.outbound !== undefined ? Boolean(body.outbound) : true,
              wake_brain: Boolean(body.wake_brain),
              payload: (body.payload as Record<string, unknown>) ?? {},
            });
            return sendJson(res, 201, { ok: true, event: emitted });
          }

          // 3. 主动唤醒接口（GUI 按钮或定时器手动触发一轮唤醒）
          if (req.method === "POST" && url.pathname === "/wake") {
            const body = await readJsonBody(req);
            const targetNode = String(body.target_node || this.core.getStatusSnapshot().nodeId);
            const emitted = await this.core.emit({
              stream: "stream:orders",
              msg_type: String(body.msg_type || "MANUAL_WAKE"),
              target_node: targetNode,
              order_id: (body.order_id as string) ?? null,
              wake_brain: body.wake_brain !== undefined ? Boolean(body.wake_brain) : true,
              payload: {
                reason: body.reason || "LOCALHOST_API_WAKE",
                ...(typeof body.payload === "object" && body.payload ? body.payload : {}),
              },
            });
            return sendJson(res, 200, { ok: true, woken: emitted });
          }

          // 4. 运行时热更新 OpenAI 协议配置
          if (req.method === "POST" && url.pathname === "/config/llm") {
            const body = await readJsonBody(req);
            const updated = this.core.updateBrainConfig(body as any);
            return sendJson(res, 200, {
              ok: true,
              brain: { ...updated, llm: { ...updated.llm, apiKey: "***" } },
            });
          }

          return sendJson(res, 404, { error: "Not Found" });
        } catch (err) {
          return sendJson(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[ControlServer] 本地控制端口已监听 http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

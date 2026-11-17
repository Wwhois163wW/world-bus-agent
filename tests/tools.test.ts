import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeWorkspaceTools } from "../src/tools.js";
import type { RawBusEventInput, WorldBusContext } from "../src/types.js";

describe("Native Workspace Tools (src/tools.ts)", () => {
  let workspaceDir: string;
  let ingestedEvents: RawBusEventInput[];
  let mockBus: WorldBusContext;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "wba-tools-"));
    ingestedEvents = [];
    mockBus = {
      nodeId: "dry.hub.01",
      workspaceDir,
      ingest: async (raw) => {
        ingestedEvents.push(raw);
        return { id: "EVT-MOCK-1", ts: new Date().toISOString(), ...raw } as any;
      },
      tick: async () => {},
      registerParticipant: () => {},
      registerTool: () => {},
      onCrash: () => {},
    };
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("支持在 workspace 内正常读写文件与列出目录 (DIARY.md / OrderForm)", async () => {
    const tools = createNativeWorkspaceTools(mockBus);

    const writeRes = await tools.write_file.execute!(
      { path: "orders/ORD-001.yaml", content: "status: CONFIRMED\n" },
      { toolCallId: "1", messages: [] }
    );
    expect(writeRes).toEqual({ ok: true, path: "orders/ORD-001.yaml", bytes: 18 });

    const listRes = await tools.list_dir.execute!(
      { path: "orders" },
      { toolCallId: "2", messages: [] }
    );
    expect(listRes).toEqual({
      ok: true,
      entries: [{ name: "ORD-001.yaml", type: "file" }],
    });

    const readRes = await tools.read_file.execute!(
      { path: "orders/ORD-001.yaml" },
      { toolCallId: "3", messages: [] }
    );
    expect(readRes).toEqual({
      ok: true,
      path: "orders/ORD-001.yaml",
      content: "status: CONFIRMED\n",
    });
  });

  it("拦截路径越界访问 (Path Traversal)，以事件/工具报错形式返回 ok: false", async () => {
    const tools = createNativeWorkspaceTools(mockBus);
    const res: any = await tools.read_file.execute!(
      { path: "../../etc/passwd" },
      { toolCallId: "1", messages: [] }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("路径越界拒绝访问");
  });

  it("exec_cli 正常执行返回 stdout，非 0 退出码时零静默返回完整 stderr 且不杀进程", async () => {
    const tools = createNativeWorkspaceTools(mockBus);

    const okRes: any = await tools.exec_cli.execute!(
      { command: 'node -e "console.log(40 + 2)"', timeoutMs: 5000 },
      { toolCallId: "1", messages: [] }
    );
    expect(okRes).toEqual({ ok: true, exitCode: 0, stdout: "42", stderr: "" });

    const failRes: any = await tools.exec_cli.execute!(
      { command: 'node -e "console.error(\'nmready qc failed\'); process.exit(2)"', timeoutMs: 5000 },
      { toolCallId: "2", messages: [] }
    );
    expect(failRes.ok).toBe(false);
    expect(failRes.exitCode).toBe(2);
    expect(failRes.stderr).toContain("nmready qc failed");
  });

  it("emit_event 遵守防自激铁律：发给本机或 * 时强制 wake=false，发给远端节点保留 wake", async () => {
    const tools = createNativeWorkspaceTools(mockBus);

    // 1. 发给全局 *，对本机强制压制 wake 为 false
    await tools.emit_event.execute!(
      {
        type: "LOCAL_NOTE",
        target: "*",
        prompt: "broadcast note",
        wake: true,
        responseMode: "optional",
        payload: {},
      },
      { toolCallId: "1", messages: [] }
    );
    expect(ingestedEvents[0].wake).toBe(false);

    // 2. 发给远端 leadership.center，保留 wake: true
    await tools.emit_event.execute!(
      {
        type: "STAGE_REPORT",
        target: "leadership.center",
        prompt: "Dry writein finished",
        wake: true,
        responseMode: "respond",
        payload: { orderId: "ORD-001" },
      },
      { toolCallId: "2", messages: [] }
    );
    expect(ingestedEvents[1].wake).toBe(true);
    expect(ingestedEvents[1].target).toBe("leadership.center");
  });
});

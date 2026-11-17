import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime, type RuntimeConfig } from "../src/main.js";

describe("Dual-Layer Error Handling & HTTP Control Surface", () => {
  let workspaceDir: string;
  let baseConfig: RuntimeConfig;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "wba-err-"));
    baseConfig = {
      nodeId: "leadership.center",
      workspaceDir,
      port: 0,
      windowSize: 20,
      tickIntervalMs: 0,
      llm: {
        enabled: true,
        baseURL: "http://localhost",
        apiKey: "mock-key",
        model: "mock-model",
        systemPrompt: "Test",
        maxSteps: 3,
      },
      extensions: [],
    };
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("1. 事件报错 (Task Error): 拓展执行抛错不杀进程，自动转为 EXTENSION_TASK_ERROR (wake=true) 唤醒女仆", async () => {
    const wokenPrompts: string[] = [];
    const runtime = await createAgentRuntime(baseConfig, {
      maidExecute: async (input) => {
        wokenPrompts.push(input.promptText);
        return { finalText: "Error handled", consumedEventIds: input.consumedEventIds, toolTrace: [] };
      },
    });

    // 注册一个会在 execute 时抛业务异常的拓展参与者
    runtime.bus.registerParticipant({
      id: "ext.sql.checker",
      consume: (_win, batch) => (batch[0]?.type === "RUN_CHECK" ? batch[0] : null),
      produce: () => [],
      execute: async () => {
        throw new Error("PostgreSQL connection refused on port 5432");
      },
    });

    // 注入一条 wake: false 的触发事件 -> 拓展报错后自动生成 EXTENSION_TASK_ERROR (wake: true) 唤醒女仆
    await runtime.bus.ingest({
      source: "timer",
      target: "leadership.center",
      type: "RUN_CHECK",
      prompt: "执行例行数据库核验",
      wake: false,
    });

    expect(wokenPrompts).toHaveLength(1);
    expect(wokenPrompts[0]).toContain("EXTENSION_TASK_ERROR");
    expect(wokenPrompts[0]).toContain("PostgreSQL connection refused on port 5432");
    expect(existsSync(join(workspaceDir, "CRASH_LATEST.json"))).toBe(false);
  });

  it("2. 底层报错 (Underlying Crash): LLM 算子崩溃或账本损坏时，旁路落盘 CRASH_LATEST.json、触发 onCrash 且不污染 events.jsonl", async () => {
    let exitCode: number | undefined;
    const crashReports: any[] = [];

    const runtime = await createAgentRuntime(baseConfig, {
      maidExecute: async () => {
        throw new Error("DeepSeek API 503 Service Unavailable");
      },
      onExit: (code) => {
        exitCode = code;
      },
    });

    runtime.bus.onCrash((report) => {
      crashReports.push(report);
    });

    await expect(
      runtime.bus.ingest({
        source: "user",
        target: "leadership.center",
        type: "USER_AIM",
        prompt: "测试底层崩溃",
        wake: true,
      })
    ).rejects.toThrow("DeepSeek API 503 Service Unavailable");

    // 1. 触发了 Fast-Fail 退出码 1 与 onCrash 旁路钩子
    expect(exitCode).toBe(1);
    expect(crashReports).toHaveLength(1);
    expect(crashReports[0].stage).toBe("MAID_TURN");

    // 2. 旁路 CRASH_LATEST.json 已落盘
    const crashJson = JSON.parse(await readFile(join(workspaceDir, "CRASH_LATEST.json"), "utf-8"));
    expect(crashJson.error.message).toContain("503 Service Unavailable");

    // 3. events.jsonl 主账本保持干净（只有原始 USER_AIM，没有写入伪造事件或 END_TURN，重启后可无损恢复回 Stock）
    const ledgerLines = (await readFile(join(workspaceDir, "events.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledgerLines).toHaveLength(1);
    expect(ledgerLines[0].type).toBe("USER_AIM");
  });

  it("3. 账本损坏底层 Fast-Fail: 启动时若 events.jsonl 存在损坏行，立即生成 BOOT 崩溃报告并退出", async () => {
    await writeFile(join(workspaceDir, "events.jsonl"), '{"bad_json": \n', "utf-8");
    let exitCode: number | undefined;

    await expect(
      createAgentRuntime(baseConfig, {
        onExit: (code) => {
          exitCode = code;
        },
      })
    ).rejects.toThrow();

    expect(exitCode).toBe(1);
    const crashJson = JSON.parse(await readFile(join(workspaceDir, "CRASH_LATEST.json"), "utf-8"));
    expect(crashJson.stage).toBe("BOOT");
  });

  it("4. Hono Localhost HTTP 接口 (/events, /status, /tick) 端到端验证", async () => {
    const runtime = await createAgentRuntime(
      { ...baseConfig, llm: { ...baseConfig.llm, enabled: false } },
      {}
    );

    // POST /events (合法事件)
    const postRes = await runtime.app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "WATCHDOG_HIT",
        prompt: "检测到新谱图落盘",
        wake: false,
      }),
    });
    expect(postRes.status).toBe(201);

    // POST /events (非法事件缺少 prompt -> 400 拦截，不写账本)
    const badRes = await runtime.app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "BROKEN_EVENT" }),
    });
    expect(badRes.status).toBe(400);

    // GET /status
    const statusRes = await runtime.app.request("/status");
    const statusBody = await statusRes.json();
    expect(statusBody.stockCount).toBe(1);
    expect(statusBody.windowCount).toBe(1);
  });
});

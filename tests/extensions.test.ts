/**
 * @file tests/extensions.test.ts
 * @description 验证 jiti 动态加载 extensions/example-echo 及其工具, 事件响应与 BOOT/Task 错误边界
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime, type RuntimeConfig } from "../src/main.js";

describe("Extension Loading & example-echo (extensions/example-echo/index.ts)", () => {
  let workspaceDir: string;
  let baseConfig: RuntimeConfig;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "wba-ext-"));
    baseConfig = {
      nodeId: "leadership.center",
      workspaceDir,
      port: 0,
      windowSize: 20,
      tickIntervalMs: 0,
      llm: {
        enabled: false,
        baseURL: "",
        apiKey: "",
        model: "",
        systemPrompt: "Test",
        maxSteps: 2,
      },
      extensions: [
        {
          module: "./extensions/example-echo/index.ts",
          options: { greeting: "Hello Echo Extension" },
        },
      ],
    };
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("1. 动态挂载 example-echo 扩展：注册 echo_ping 工具并响应 PING_TEST 产出 PONG_RESULT", async () => {
    const runtime = await createAgentRuntime(baseConfig);

    // 验证 /status 中已暴露扩展注册的工具
    const statusRes = await runtime.app.request("/status");
    const statusBody = await statusRes.json();
    expect(statusBody.tools).toContain("echo_ping");

    // 验证 echo_ping 工具可直接执行
    const echoToolRes = await runtime.tools.echo_ping.execute!(
      { message: "nmr-ready" },
      { toolCallId: "t-1", messages: [] }
    );
    expect(echoToolRes).toEqual({
      ok: true,
      nodeId: "leadership.center",
      greeting: "Hello Echo Extension",
      echoed: "nmr-ready",
    });

    // 注入 PING_TEST 事件 -> 扩展参与者自动消费并生成 PONG_RESULT
    await runtime.bus.ingest({
      source: "tester",
      target: "leadership.center",
      type: "PING_TEST",
      prompt: "ping bus",
      wake: false,
      payload: { seq: 1 },
    });

    const types = runtime.getState().eventsWindow.map((e) => e.type);
    expect(types).toEqual(["PING_TEST", "PONG_RESULT"]);
    const pong = runtime.getState().eventsWindow[1];
    expect(pong.source).toBe("ext.example.echo");
    expect(pong.target).toBe("tester");
    expect(pong.prompt).toContain("Hello Echo Extension");
  });

  it("2. 扩展执行异常降级 (Layer 1): simulateError=true 触发 EXTENSION_TASK_ERROR 而不崩溃", async () => {
    const wokenPrompts: string[] = [];
    const runtime = await createAgentRuntime(
      {
        ...baseConfig,
        llm: { ...baseConfig.llm, enabled: true },
      },
      {
        maidExecute: async (input) => {
          wokenPrompts.push(input.promptText);
          return {
            finalText: "Handled extension error",
            consumedEventIds: input.consumedEventIds,
            toolTrace: [],
          };
        },
      }
    );

    await runtime.bus.ingest({
      source: "tester",
      target: "leadership.center",
      type: "PING_TEST",
      prompt: "trigger error",
      wake: false,
      payload: { simulateError: true },
    });

    expect(wokenPrompts).toHaveLength(1);
    expect(wokenPrompts[0]).toContain("EXTENSION_TASK_ERROR");
    expect(wokenPrompts[0]).toContain("Simulated extension failure on PING_TEST");
    expect(existsSync(join(workspaceDir, "CRASH_LATEST.json"))).toBe(false);
  });

  it("3. 扩展配置 enabled=false 跳过加载; 模块不存在时触发 BOOT Fast-Fail", async () => {
    // 3a. enabled=false 跳过
    const skippedRuntime = await createAgentRuntime({
      ...baseConfig,
      extensions: [{ module: "./extensions/non-existent/index.ts", enabled: false }],
    });
    expect(Object.keys(skippedRuntime.tools)).not.toContain("echo_ping");

    // 3b. enabled!=false 且模块缺失 -> BOOT 崩溃报告
    let exitCode: number | undefined;
    await expect(
      createAgentRuntime(
        {
          ...baseConfig,
          extensions: [{ module: "./extensions/non-existent/index.ts" }],
        },
        {
          onExit: (code) => {
            exitCode = code;
          },
        }
      )
    ).rejects.toThrow();

    expect(exitCode).toBe(1);
    const crashJson = JSON.parse(await readFile(join(workspaceDir, "CRASH_LATEST.json"), "utf-8"));
    expect(crashJson.stage).toBe("BOOT");
  });

  // @Antigravity, 20261118, [TEST]: 验证扩展 Manifest 自动注入女仆 Prompt 与优雅停机保护
  it("4. 扩展动态加载与 LLM 感知: 自动通过 jiti 加载 example-echo 并将其 manifest 注入女仆 Prompt", async () => {
    let capturedPrompt = "";
    const runtime = await createAgentRuntime(
      {
        ...baseConfig,
        llm: { ...baseConfig.llm, enabled: true },
        extensions: [
          {
            module: "./extensions/example-echo/index.ts",
            options: { prefix: "NMR_ECHO" },
          },
        ],
      },
      {
        maidExecute: async (input) => {
          capturedPrompt = input.promptText;
          return {
            finalText: "I see ext.example.echo",
            consumedEventIds: input.consumedEventIds,
            toolTrace: [],
          };
        },
      }
    );

    await runtime.bus.ingest({
      source: "user",
      target: "*",
      type: "PING_TEST",
      prompt: "测试扩展回显与感知",
      wake: true,
      payload: { message: "hello-bus" },
    });

    const windowTypes = runtime.getState().eventsWindow.map((e) => e.type);
    expect(windowTypes).toContain("PONG_RESULT");
    expect(capturedPrompt).toContain("已挂载总线扩展目录");
    expect(capturedPrompt).toContain("ext.example.echo");
    expect(capturedPrompt).toContain("PING_TEST");
    expect(capturedPrompt).toContain("PONG_RESULT");
  });

  it("5. 优雅停机保护: runtime.shutdown() 等待当前 busy 回合 END_TURN 落盘后才完成", async () => {
    let releaseMaid!: () => void;
    const maidGate = new Promise<void>((r) => {
      releaseMaid = r;
    });

    const runtime = await createAgentRuntime(
      {
        ...baseConfig,
        llm: { ...baseConfig.llm, enabled: true },
        extensions: [],
      },
      {
        maidExecute: async (input) => {
          await maidGate;
          return {
            finalText: "Turn settled safely before shutdown",
            consumedEventIds: input.consumedEventIds,
            toolTrace: [],
          };
        },
      }
    );

    // 启动一个正在进行中的女仆回合 (busy=true)
    const ingestPromise = runtime.bus.ingest({
      source: "user",
      target: "leadership.center",
      type: "LONG_TASK",
      prompt: "执行耗时任务",
      wake: true,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.getState().busy).toBe(true);

    let shutdownCompleted = false;
    const shutdownPromise = runtime.shutdown().then(() => {
      shutdownCompleted = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(shutdownCompleted).toBe(false);

    releaseMaid();
    await Promise.all([ingestPromise, shutdownPromise]);

    expect(shutdownCompleted).toBe(true);
    expect(runtime.getState().busy).toBe(false);
    expect(runtime.getState().eventsWindow.map((e) => e.type)).toEqual(["LONG_TASK", "END_TURN"]);
  });
});

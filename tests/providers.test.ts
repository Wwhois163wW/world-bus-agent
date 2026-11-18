// @Antigravity, 20261118, [TEST]: 新增模型提供商预设自动填充与路由协议单测
import { describe, it, expect } from "vitest";
import { resolveLlmConfig, PROVIDER_PRESETS } from "../src/providers.js";

describe("LLM Provider Presets & Auto-Fill (src/providers.ts)", () => {
  it("仅设置 provider 与 apiKey 时自动填充默认 baseURL 与 model", () => {
    const deepseek = resolveLlmConfig({
      provider: "deepseek",
      apiKey: "sk-test",
    });
    expect(deepseek.protocol).toBe("openai-compatible");
    expect(deepseek.baseURL).toBe(PROVIDER_PRESETS.deepseek.defaultBaseURL);
    expect(deepseek.model).toBe(PROVIDER_PRESETS.deepseek.defaultModel);

    // @Antigravity, 20261118, [REFACTOR]: vertex-express 已合并至 gemini (@google/genai)
    // const vertex = resolveLlmConfig({
    //   provider: "vertex-express",
    //   apiKey: "AQ.test-key",
    // });
    // expect(vertex.protocol).toBe("vertex");
    // expect(vertex.model).toBe("gemini-2.5-flash");
    const gemini = resolveLlmConfig({
      provider: "gemini",
      apiKey: "AQ.test-key",
    });
    expect(gemini.protocol).toBe("google-genai");
    expect(gemini.model).toBe("gemini-4-hydrogen");
  });

  it("未显式指定 provider 时根据 apiKey 前缀自动识别协议预设", () => {
    // @Antigravity, 20261118, [REFACTOR]: AQ. 与 AIza 统一识别为 gemini (@google/genai)
    // const aqResolved = resolveLlmConfig({ apiKey: "AQ.Ab8RN6-mock" });
    // expect(aqResolved.provider).toBe("vertex-express");
    // expect(aqResolved.protocol).toBe("vertex");
    // expect(aqResolved.model).toBe("gemini-2.5-flash");
    //
    // const aizaResolved = resolveLlmConfig({ apiKey: "AIzaSyMockKey" });
    // expect(aizaResolved.provider).toBe("gemini");
    // expect(aizaResolved.protocol).toBe("openai-compatible");
    // expect(aizaResolved.baseURL).toContain("generativelanguage.googleapis.com");
    const aqResolved = resolveLlmConfig({ apiKey: "AQ.Ab8RN6-mock" });
    expect(aqResolved.provider).toBe("gemini");
    expect(aqResolved.protocol).toBe("google-genai");
    expect(aqResolved.model).toBe("gemini-4-hydrogen");

    const aizaResolved = resolveLlmConfig({ apiKey: "AIzaSyMockKey" });
    expect(aizaResolved.provider).toBe("gemini");
    expect(aizaResolved.protocol).toBe("google-genai");
    expect(aizaResolved.model).toBe("gemini-4-hydrogen");
  });

  it("显式传入 baseURL 与 model 时覆盖模板默认值", () => {
    const custom = resolveLlmConfig({
      provider: "gemini",
      apiKey: "AQ.Ab8RN6-mock",
      model: "gemini-2.5-pro",
      baseURL: "https://custom-proxy.example.com/v1",
    });
    expect(custom.model).toBe("gemini-2.5-pro");
    expect(custom.baseURL).toBe("https://custom-proxy.example.com/v1");
  });
});

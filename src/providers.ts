// @Antigravity, 20261118, [REFACTOR]: 卸载 @ai-sdk/google-vertex, 改用官方标准 @google/genai Interactions API
// import { generateText, type LanguageModel } from "ai";
// import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
// import { createVertex } from "@ai-sdk/google-vertex";
//
// export type LlmProtocol = "openai-compatible" | "vertex";
import { asSchema, generateText, stepCountIs, ToolLoopAgent, type LanguageModel, type Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { GoogleGenAI, type Interactions } from "@google/genai";

export type LlmProtocol = "openai-compatible" | "google-genai";

export interface LlmConfig {
  enabled: boolean;
  provider?: string;
  baseURL?: string;
  apiKey: string;
  model?: string;
  systemPrompt: string;
  maxSteps: number;
}

export interface ProviderPreset {
  readonly id: string;
  readonly protocol: LlmProtocol;
  readonly defaultBaseURL?: string;
  readonly defaultModel: string;
  readonly description: string;
}

export interface ResolvedLlmConfig {
  provider: string;
  protocol: LlmProtocol;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LlmConnectionTestResult {
  ok: boolean;
  provider: string;
  protocol: LlmProtocol;
  model: string;
  baseURL: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  // @Antigravity, 20261118, [REFACTOR]: 将 Gemini 系列统一到 @google/genai 标准 SDK (Interactions API)
  // "vertex-express": {
  //   id: "vertex-express",
  //   protocol: "vertex",
  //   defaultBaseURL: "https://aiplatform.googleapis.com/v1",
  //   defaultModel: "gemini-2.5-flash",
  //   description: "Google Vertex AI Express Mode (使用 AQ.xxx API Key)",
  // },
  // gemini: {
  //   id: "gemini",
  //   protocol: "openai-compatible",
  //   defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  //   defaultModel: "gemini-2.5-flash",
  //   description: "Google AI Studio (OpenAI 兼容接口, AIza... API Key)",
  // },
  gemini: {
    id: "gemini",
    protocol: "google-genai",
    defaultBaseURL: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-4-hydrogen",
    description: "Google Gemini 官方标准 SDK (@google/genai, 支持 AQ. 与 AIza 密钥)",
  },
  openai: {
    id: "openai",
    protocol: "openai-compatible",
    defaultBaseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    description: "OpenAI 官方 API",
  },
  deepseek: {
    id: "deepseek",
    protocol: "openai-compatible",
    defaultBaseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    description: "DeepSeek 官方 API",
  },
  openrouter: {
    id: "openrouter",
    protocol: "openai-compatible",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    description: "OpenRouter 多模型聚合网关",
  },
  ollama: {
    id: "ollama",
    protocol: "openai-compatible",
    defaultBaseURL: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5",
    description: "本地 Ollama OpenAI 兼容服务",
  },
  "openai-compatible": {
    id: "openai-compatible",
    protocol: "openai-compatible",
    defaultBaseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    description: "通用 OpenAI 兼容协议端点",
  },
};

function inferProviderId(llm: Pick<LlmConfig, "provider" | "apiKey" | "baseURL">): string {
  const explicit = llm.provider?.trim().toLowerCase();
  if (explicit) return explicit;
  // @Antigravity, 20261118, [REFACTOR]: AQ. 与 AIza 密钥统一自动识别为 gemini (@google/genai)
  // if (llm.apiKey?.trim().startsWith("AQ.")) return "vertex-express";
  // if (llm.apiKey?.trim().startsWith("AIza")) return "gemini";
  if (llm.apiKey?.trim().startsWith("AQ.") || llm.apiKey?.trim().startsWith("AIza")) {
    return "gemini";
  }
  return "openai-compatible";
}

/**
 * 解析并按提供商预设自动填充 baseURL 与默认 model
 */
export function resolveLlmConfig(
  llm: Pick<LlmConfig, "provider" | "baseURL" | "apiKey" | "model">
): ResolvedLlmConfig {
  const providerId = inferProviderId(llm);
  const preset = PROVIDER_PRESETS[providerId];

  if (!preset && !llm.baseURL) {
    const supported = Object.keys(PROVIDER_PRESETS).join(", ");
    throw new Error(
      `未知的 LLM 提供商 "${providerId}", 请提供 baseURL 或使用内置预设: ${supported}`
    );
  }

  const protocol: LlmProtocol = preset?.protocol ?? "openai-compatible";
  const baseURL = (llm.baseURL?.trim() || preset?.defaultBaseURL || "").trim();
  const model = (llm.model?.trim() || preset?.defaultModel || "").trim();

  if (protocol === "openai-compatible" && !baseURL) {
    throw new Error(`提供商 "${providerId}" 缺少 baseURL 配置`);
  }
  if (!model) {
    throw new Error(`提供商 "${providerId}" 缺少 model 配置`);
  }

  return {
    provider: preset?.id ?? providerId,
    protocol,
    baseURL,
    apiKey: llm.apiKey?.trim() ?? "",
    model,
  };
}

/**
 * 根据解析后的配置创建 Vercel AI SDK LanguageModel 实例（适用于 OpenAI-Compatible 提供商）
 */
export function createLanguageModel(
  llm: Pick<LlmConfig, "provider" | "baseURL" | "apiKey" | "model">
): { model: LanguageModel; resolved: ResolvedLlmConfig } {
  const resolved = resolveLlmConfig(llm);
  if (!resolved.apiKey && resolved.provider !== "ollama") {
    throw new Error(`提供商 "${resolved.provider}" 缺少 apiKey`);
  }

  // @Antigravity, 20261118, [REFACTOR]: 移除 @ai-sdk/google-vertex, google-genai 协议由 GoogleGenAI 原生执行
  // if (resolved.protocol === "vertex") {
  //   const vertex = createVertex({
  //     apiKey: resolved.apiKey,
  //     ...(llm.baseURL?.trim() ? { baseURL: llm.baseURL.trim() } : {}),
  //   });
  //   return {
  //     model: vertex(resolved.model),
  //     resolved,
  //   };
  // }
  if (resolved.protocol === "google-genai") {
    throw new Error(`提供商 "${resolved.provider}" 使用 @google/genai 协议, 请通过 runLlmTurn 执行`);
  }

  const compatible = createOpenAICompatible({
    name: resolved.provider,
    baseURL: resolved.baseURL,
    apiKey: resolved.apiKey || "ollama",
  });
  return {
    model: compatible(resolved.model),
    resolved,
  };
}

/**
 * 统一执行单轮智能体推理与工具循环（支持 OpenAI-Compatible 与 @google/genai）
 */
export async function runLlmTurn(params: {
  llm: Omit<LlmConfig, "enabled"> & { enabled?: boolean };
  tools: Record<string, Tool>;
  promptText: string;
  requiresTool: boolean;
}): Promise<{ finalText: string; toolTrace: Array<{ toolName: string; args: unknown }> }> {
  const resolved = resolveLlmConfig(params.llm);
  if (!resolved.apiKey && resolved.provider !== "ollama") {
    throw new Error(`提供商 "${resolved.provider}" 缺少 apiKey`);
  }

  if (resolved.protocol === "google-genai") {
    const genai = new GoogleGenAI({ apiKey: resolved.apiKey });
    const toolEntries = Object.entries(params.tools);
    const fnDecls: Interactions.Tool[] = await Promise.all(
      toolEntries.map(async ([name, toolDef]) => {
        const schema = await asSchema(toolDef.inputSchema).jsonSchema;
        return {
          type: "function" as const,
          name,
          description: toolDef.description ?? "",
          parameters: schema,
        };
      })
    );

    const toolTrace: Array<{ toolName: string; args: unknown }> = [];
    let interaction = await genai.interactions.create({
      model: resolved.model,
      system_instruction: params.llm.systemPrompt,
      input: params.promptText,
      ...(fnDecls.length > 0 ? { tools: fnDecls } : {}),
      generation_config: {
        ...(fnDecls.length > 0
          ? { tool_choice: params.requiresTool ? ("any" as const) : ("auto" as const) }
          : {}),
      },
    });

    const maxSteps = Math.max(1, params.llm.maxSteps || 1);
    for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
      const fnCalls = (interaction.steps ?? []).filter(
        (s): s is Interactions.FunctionCallStep => s.type === "function_call"
      );
      if (fnCalls.length === 0) break;

      const fnResults: Interactions.FunctionResultStep[] = [];
      for (const call of fnCalls) {
        toolTrace.push({ toolName: call.name, args: call.arguments });
        const targetTool = params.tools[call.name];
        if (!targetTool?.execute) {
          fnResults.push({
            type: "function_result",
            call_id: call.id,
            name: call.name,
            is_error: true,
            result: JSON.stringify({ ok: false, error: `Tool "${call.name}" not executable` }),
          });
          continue;
        }
        try {
          const out = await targetTool.execute(call.arguments, {
            toolCallId: call.id,
            messages: [],
          });
          fnResults.push({
            type: "function_result",
            call_id: call.id,
            name: call.name,
            result: typeof out === "string" ? out : JSON.stringify(out),
          });
        } catch (err: any) {
          fnResults.push({
            type: "function_result",
            call_id: call.id,
            name: call.name,
            is_error: true,
            result: JSON.stringify({ ok: false, error: err?.message ?? String(err) }),
          });
        }
      }

      interaction = await genai.interactions.create({
        model: resolved.model,
        previous_interaction_id: interaction.id,
        input: fnResults,
        ...(fnDecls.length > 0 ? { tools: fnDecls } : {}),
      });
    }

    return {
      finalText: interaction.output_text ?? "",
      toolTrace,
    };
  }

  const { model } = createLanguageModel(params.llm);
  const agent = new ToolLoopAgent({
    model,
    instructions: params.llm.systemPrompt,
    tools: params.tools,
    toolChoice: params.requiresTool ? "required" : "auto",
    stopWhen: stepCountIs(params.llm.maxSteps),
  });
  const res = await agent.generate({ prompt: params.promptText });
  const toolTrace = res.steps.flatMap((s) =>
    (s.toolCalls ?? []).map((tc) => ({ toolName: tc.toolName, args: tc.input }))
  );

  return {
    finalText: res.text,
    toolTrace,
  };
}

/**
 * 执行最小化 LLM 连通性探针测试
 */
export async function testLlmConnection(
  llm: Pick<LlmConfig, "provider" | "baseURL" | "apiKey" | "model">
): Promise<LlmConnectionTestResult> {
  const startedAt = Date.now();
  let resolved: ResolvedLlmConfig;

  try {
    resolved = resolveLlmConfig(llm);
    if (!resolved.apiKey && resolved.provider !== "ollama") {
      throw new Error(`提供商 "${resolved.provider}" 缺少 apiKey`);
    }

    if (resolved.protocol === "google-genai") {
      const genai = new GoogleGenAI({ apiKey: resolved.apiKey });
      const interaction = await genai.interactions.create({
        model: resolved.model,
        input: "Reply with exactly: OK",
        generation_config: { max_output_tokens: 16 },
      });
      return {
        ok: true,
        provider: resolved.provider,
        protocol: resolved.protocol,
        model: resolved.model,
        baseURL: resolved.baseURL,
        latencyMs: Date.now() - startedAt,
        reply: (interaction.output_text ?? "").trim(),
      };
    }

    const built = createLanguageModel(llm);
    const res = await generateText({
      model: built.model,
      prompt: "Reply with exactly: OK",
      maxOutputTokens: 16,
    });
    return {
      ok: true,
      provider: built.resolved.provider,
      protocol: built.resolved.protocol,
      model: built.resolved.model,
      baseURL: built.resolved.baseURL,
      latencyMs: Date.now() - startedAt,
      reply: res.text.trim(),
    };
  } catch (err: any) {
    const fallbackResolved = (() => {
      try {
        return resolveLlmConfig(llm);
      } catch {
        return {
          provider: llm.provider || "unknown",
          protocol: "openai-compatible" as LlmProtocol,
          model: llm.model || "",
          baseURL: llm.baseURL || "",
          apiKey: "",
        };
      }
    })();

    return {
      ok: false,
      provider: fallbackResolved.provider,
      protocol: fallbackResolved.protocol,
      model: fallbackResolved.model,
      baseURL: fallbackResolved.baseURL,
      latencyMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
    };
  }
}

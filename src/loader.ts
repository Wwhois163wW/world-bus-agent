import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentExtension, ExtensionFactory } from "./types.js";

export async function loadExtensionModule(
  moduleSpec: string,
  options: Record<string, unknown> = {},
  baseDir = process.cwd()
): Promise<AgentExtension> {
  // 支持相对路径（本地开发）与裸包名（独立仓库 npm link / install）
  const resolvedSpecifier =
    moduleSpec.startsWith(".") || moduleSpec.startsWith("/")
      ? pathToFileURL(resolve(baseDir, moduleSpec)).href
      : moduleSpec;

  const mod = await import(resolvedSpecifier);
  const exported: AgentExtension | ExtensionFactory | undefined =
    mod.default ?? mod.extension ?? mod.createExtension;

  if (!exported) {
    throw new Error(`拓展模块 [${moduleSpec}] 未导出 default / extension / createExtension`);
  }

  if (typeof exported === "function") {
    return await (exported as ExtensionFactory)(options);
  }
  return exported;
}

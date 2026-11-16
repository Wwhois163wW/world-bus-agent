import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WorldBusCore } from "./WorldBusCore.js";
import { LocalControlServer } from "./ControlServer.js";
import { loadExtensionModule } from "./loader.js";
import type { AgentCoreConfig } from "./types.js";

async function main() {
  const cfgIdx = process.argv.indexOf("--config");
  const cfgPath = resolve(cfgIdx !== -1 ? process.argv[cfgIdx + 1] : "./agent.config.json");
  const raw = await readFile(cfgPath, "utf-8");
  const config: AgentCoreConfig = JSON.parse(raw);

  const core = new WorldBusCore(config);

  // 动态挂载所有启用的独立拓展
  for (const extCfg of config.extensions ?? []) {
    if (extCfg.enabled === false) continue;
    const ext = await loadExtensionModule(
      extCfg.module,
      extCfg.options ?? {},
      dirname(cfgPath)
    );
    core.use(ext);
  }

  await core.boot();

  let controlServer: LocalControlServer | undefined;
  if (config.controlServer?.enabled !== false) {
    controlServer = new LocalControlServer(
      core,
      config.controlServer?.host ?? "127.0.0.1",
      config.controlServer?.port ?? 3100
    );
    await controlServer.start();
  }

  const gracefulExit = async () => {
    console.log("\n正在优雅停机...");
    if (controlServer) await controlServer.stop();
    await core.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);
}

main().catch((err) => {
  console.error("Agent 启动失败:", err);
  process.exit(1);
});

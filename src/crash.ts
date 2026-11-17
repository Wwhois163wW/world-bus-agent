import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CrashReport {
  id: string;
  ts: string;
  nodeId: string;
  stage: "BOOT" | "LEDGER_IO" | "MAID_TURN" | "UNCAUGHT";
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  contextSnapshot?: unknown;
}

/**
 * 底层报错专用：纯旁路同步落盘崩溃报告（不写 events.jsonl，不依赖主事件流）
 */
export function dumpCrashReportSync(params: {
  nodeId: string;
  workspaceDir: string;
  stage: CrashReport["stage"];
  error: unknown;
  contextSnapshot?: unknown;
}): CrashReport {
  const now = new Date();
  const errObj =
    params.error instanceof Error
      ? { name: params.error.name, message: params.error.message, stack: params.error.stack }
      : { name: "UnknownError", message: String(params.error) };

  const report: CrashReport = {
    id: `CRASH-${now.getTime()}`,
    ts: now.toISOString(),
    nodeId: params.nodeId,
    stage: params.stage,
    error: errObj,
    contextSnapshot: params.contextSnapshot,
  };

  try {
    const crashDir = join(params.workspaceDir, "crashes");
    mkdirSync(crashDir, { recursive: true });
    const serialized = JSON.stringify(report, null, 2);
    writeFileSync(join(crashDir, `${report.id}.json`), serialized, "utf-8");
    writeFileSync(join(params.workspaceDir, "CRASH_LATEST.json"), serialized, "utf-8");
  } catch (fsErr) {
    console.error("[CRITICAL] 无法写入旁路崩溃报告文件:", fsErr);
  }

  console.error(`\n💥 [FAST-FAIL][${report.nodeId}][${report.stage}] ${errObj.message}`);
  if (errObj.stack) console.error(errObj.stack);

  return report;
}

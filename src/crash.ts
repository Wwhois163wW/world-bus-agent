import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CrashReport {
  id: string;
  ts: string;
  nodeId: string;
  stage: "BOOT" | "INGEST_ZOD" | "MAID_TURN" | "PARTICIPANT_EXEC" | "UNCAUGHT";
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  /** 崩溃瞬间正在处理或导致崩溃的原始数据快照 */
  contextSnapshot?: unknown;
}

/**
 * 纯旁路同步落盘崩溃报告：
 * - 绝不触碰 events.jsonl 主账本，保持主事件流断点干净
 * - 独立写入 workspace/crashes/ 与 workspace/CRASH_LATEST.json
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
    // 1. 留存历史崩溃档案
    writeFileSync(join(crashDir, `${report.id}.json`), serialized, "utf-8");
    // 2. 覆盖写入最新崩溃指针，方便外部守护脚本或人工第一眼读取
    writeFileSync(join(params.workspaceDir, "CRASH_LATEST.json"), serialized, "utf-8");
  } catch (fsErr) {
    console.error("[CRITICAL] 无法写入崩溃报告文件:", fsErr);
  }

  console.error(`\n💥 [FAST-FAIL][${report.nodeId}][${report.stage}] ${errObj.message}`);
  if (errObj.stack) console.error(errObj.stack);

  return report;
}

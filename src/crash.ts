import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BusEvent } from "./types.js";

export interface CrashContext {
  nodeId: string;
  workspaceDir: string;
  stage: "BOOT" | "INGEST_ZOD" | "MAID_TURN" | "PARTICIPANT_EXEC" | "UNCAUGHT";
  error: unknown;
  triggerBatch?: ReadonlyArray<BusEvent>;
  extra?: Record<string, unknown>;
}

/**
 * 构造标准 CRASH_REPORT 事件，同步落盘到 workspace/CRASH_LATEST.json 与 events.jsonl
 * 绝不吞掉任何字段，确保事后 100% 还原事故现场
 */
export function writeCrashReportSync(ctx: CrashContext): BusEvent {
  const errObj =
    ctx.error instanceof Error
      ? { name: ctx.error.name, message: ctx.error.message, stack: ctx.error.stack }
      : { name: "UnknownError", message: String(ctx.error), stack: undefined };

  const crashEvent: BusEvent = {
    id: `CRASH-${Date.now()}-${randomUUID().slice(0, 5)}`,
    ts: new Date().toISOString(),
    source: ctx.nodeId,
    target: "*",
    type: "CRASH_REPORT",
    prompt: `[CRITICAL CRASH] Node "${ctx.nodeId}" failed at stage "${ctx.stage}": ${errObj.message}`,
    wake: true,
    responseMode: "respond",
    outbound: true,
    payload: {
      stage: ctx.stage,
      error: errObj,
      triggerEventIds: (ctx.triggerBatch ?? []).map((e) => e.id),
      triggerBatch: ctx.triggerBatch ?? [],
      ...ctx.extra,
    },
  };

  mkdirSync(ctx.workspaceDir, { recursive: true });

  // 1. 写入独立崩溃快照文件，方便人工 SSH 上去第一眼排查
  const crashFilePath = join(ctx.workspaceDir, "CRASH_LATEST.json");
  writeFileSync(crashFilePath, JSON.stringify(crashEvent, null, 2), "utf-8");

  // 2. 追加写入 events.jsonl 主账本留痕
  const ledgerPath = join(ctx.workspaceDir, "events.jsonl");
  appendFileSync(ledgerPath, JSON.stringify(crashEvent) + "\n", "utf-8");

  console.error(`\n💥 [FAST-FAIL][${ctx.nodeId}][${ctx.stage}] ${errObj.message}`);
  if (errObj.stack) console.error(errObj.stack);

  return crashEvent;
}

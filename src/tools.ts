import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, dirname } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "./types.js";

const execAsync = promisify(exec);

/** 确保相对路径不会逃逸出 workspace 沙箱 */
function resolveSafePath(workspaceDir: string, relPath: string): string {
  const full = resolve(workspaceDir, relPath);
  const rel = relative(workspaceDir, full);
  if (rel.startsWith("..") || resolve(workspaceDir, rel) !== full) {
    throw new Error(`路径越界拒绝访问: ${relPath}`);
  }
  return full;
}

export function createNativeTools(ctx: AgentContext): Record<string, Tool> {
  return {
    // 1. 读取 workspace 下的文件 (如 OrderForm 草稿、Diary、配置等)
    read_file: tool({
      description: "读取 workspace 目录下的文本文件内容",
      parameters: z.object({
        path: z.string().describe("相对于 workspace 的文件路径"),
      }),
      execute: async ({ path }) => {
        const full = resolveSafePath(ctx.workspaceDir, path);
        const content = await readFile(full, "utf-8");
        return { path, content };
      },
    }),

    // 2. 写入或更新 workspace 下的文件 (如生成 OrderForm YAML、REPORT.md、DIARY.md、.sql/.ttl)
    write_file: tool({
      description: "在 workspace 目录下创建或覆盖写入文件",
      parameters: z.object({
        path: z.string().describe("相对于 workspace 的文件路径"),
        content: z.string().describe("完整文件内容"),
      }),
      execute: async ({ path, content }) => {
        const full = resolveSafePath(ctx.workspaceDir, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf-8");
        return { ok: true, path, bytes: Buffer.byteLength(content) };
      },
    }),

    // 3. 列出目录内容
    list_dir: tool({
      description: "列出 workspace 指定子目录下的文件与文件夹",
      parameters: z.object({
        path: z.string().default(".").describe("相对于 workspace 的目录路径"),
      }),
      execute: async ({ path }) => {
        const full = resolveSafePath(ctx.workspaceDir, path);
        const entries = await readdir(full, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
        }));
      },
    }),

    // 4. 执行本地 CLI 命令 / Python 脚本 (如调用 APScheduler、nmready、SQLAlchemy、CheckSQL)
    exec_cli: tool({
      description: "在 workspace 工作目录下执行 Shell / Python CLI 命令并返回 stdout/stderr",
      parameters: z.object({
        command: z.string().describe("要执行的命令行"),
        timeoutMs: z.number().default(30_000).describe("超时毫秒数"),
      }),
      execute: async ({ command, timeoutMs }) => {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: ctx.workspaceDir,
            timeout: timeoutMs,
          });
          return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
        } catch (err: any) {
          return {
            exitCode: err.code ?? 1,
            stdout: (err.stdout ?? "").trim(),
            stderr: (err.stderr ?? err.message ?? "").trim(),
          };
        }
      },
    }),

    // 5. 向世界总线发射新事件 (通知其他拓展或跨节点桥接器)
    emit_event: tool({
      description: "向事件总线注入一条新事件（如派发 Order、回传 Report 或状态更新）",
      parameters: z.object({
        type: z.string().describe("事件类型，如 ORDER_DISPATCHED / STAGE_REPORT"),
        target: z.string().default("*").describe("目标节点或 *"),
        prompt: z.string().describe("事件的自然语言/提示词描述"),
        wake: z.boolean().default(false).describe("是否要求接收方立即 Wake"),
        responseMode: z.enum(["optional", "respond", "tool_required"]).default("optional"),
        payload: z.record(z.unknown()).default({}).describe("结构化附加数据"),
      }),
      execute: async (params) => {
        // LLM 自己发出的事件对本节点不触发递归 Wake，防止自激死循环
        const emitted = await ctx.emit({
          ...params,
          wake: params.target !== ctx.nodeId && params.target !== "*" ? params.wake : false,
        });
        return { emittedId: emitted.id };
      },
    }),
  };
}

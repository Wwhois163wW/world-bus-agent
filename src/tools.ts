import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, dirname } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { WorldBusContext } from "./types.js";

const execAsync = promisify(exec);

function resolveSafePath(workspaceDir: string, relPath: string): string {
  const full = resolve(workspaceDir, relPath);
  const rel = relative(workspaceDir, full);
  if (rel.startsWith("..") || resolve(workspaceDir, rel) !== full) {
    throw new Error(`路径越界拒绝访问: ${relPath}`);
  }
  return full;
}

export function createNativeWorkspaceTools(bus: WorldBusContext): Record<string, Tool> {
  return {
    read_file: tool({
      description: "读取 workspace 工作区内的文件",
      // @Antigravity, 20261118, [FIX]: 对齐 ai@6 tool() 接口 (parameters -> inputSchema)
      // parameters: z.object({ path: z.string() }),
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        try {
          const content = await readFile(resolveSafePath(bus.workspaceDir, path), "utf-8");
          return { ok: true, path, content };
        } catch (err: any) {
          return { ok: false, path, error: err.message ?? String(err) };
        }
      },
    }),

    write_file: tool({
      description: "写入或更新 workspace 工作区内的文件（如 DIARY.md, OrderForm, REPORT.md）",
      // @Antigravity, 20261118, [FIX]: 对齐 ai@6 tool() 接口 (parameters -> inputSchema)
      // parameters: z.object({ path: z.string(), content: z.string() }),
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        try {
          const full = resolveSafePath(bus.workspaceDir, path);
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, content, "utf-8");
          return { ok: true, path, bytes: Buffer.byteLength(content) };
        } catch (err: any) {
          return { ok: false, path, error: err.message ?? String(err) };
        }
      },
    }),

    list_dir: tool({
      description: "列出 workspace 指定目录内容",
      // @Antigravity, 20261118, [FIX]: 对齐 ai@6 tool() 接口 (parameters -> inputSchema)
      // parameters: z.object({ path: z.string().default(".") }),
      inputSchema: z.object({ path: z.string().default(".") }),
      execute: async ({ path }) => {
        try {
          const entries = await readdir(resolveSafePath(bus.workspaceDir, path), { withFileTypes: true });
          return {
            ok: true,
            entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
          };
        } catch (err: any) {
          return { ok: false, path, error: err.message ?? String(err) };
        }
      },
    }),

    exec_cli: tool({
      description: "在 workspace 下执行本地 CLI / Python 脚本命令",
      // @Antigravity, 20261118, [FIX]: 对齐 ai@6 tool() 接口 (parameters -> inputSchema)
      // parameters: z.object({
      //   command: z.string(),
      //   timeoutMs: z.number().default(30_000),
      // }),
      inputSchema: z.object({
        command: z.string(),
        timeoutMs: z.number().default(30_000),
      }),
      execute: async ({ command, timeoutMs }) => {
        try {
          const { stdout, stderr } = await execAsync(command, { cwd: bus.workspaceDir, timeout: timeoutMs });
          return { ok: true, exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
        } catch (err: any) {
          return {
            ok: false,
            exitCode: err.code ?? 1,
            command,
            stdout: (err.stdout ?? "").trim(),
            stderr: (err.stderr ?? err.message ?? "").trim(),
          };
        }
      },
    }),

    emit_event: tool({
      description: "向事件总线生产并注入一条新事件（含正常业务事件或异常告警事件）",
      // @Antigravity, 20261118, [FIX]: 对齐 ai@6 tool() 接口 (parameters -> inputSchema)
      // parameters: z.object({
      //   type: z.string(),
      //   target: z.string().default("*"),
      //   prompt: z.string(),
      //   wake: z.boolean().default(false),
      //   responseMode: z.enum(["optional", "respond", "tool_required"]).default("optional"),
      //   payload: z.record(z.unknown()).default({}),
      // }),
      inputSchema: z.object({
        type: z.string(),
        target: z.string().default("*"),
        prompt: z.string(),
        wake: z.boolean().default(false),
        responseMode: z.enum(["optional", "respond", "tool_required"]).default("optional"),
        payload: z.record(z.unknown()).default({}),
      }),
      execute: async (params) => {
        const evt = await bus.ingest({
          ...params,
          source: bus.nodeId,
          wake: params.target !== bus.nodeId && params.target !== "*" ? params.wake : false,
        });
        return { ok: true, emittedEventId: evt.id };
      },
    }),
  };
}

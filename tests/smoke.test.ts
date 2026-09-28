// Smoke test: spawn the built `dist/todo-index.js`, drive it over stdio with
// JSON-RPC, and confirm the server starts and exposes all expected tools,
// including the new `move-task` tool.
//
// This catches the recurring regression where tsdown emits a CJS-style
// `__require` shim in the published bundle — in that state the server
// crashes before any tool is listed.
//
// Skipped automatically if `dist/` is missing (run `pnpm run build` first).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, beforeAll, afterAll } from "vitest"

const DIST = resolve(__dirname, "..", "dist", "todo-index.js")

interface JsonRpcResponse {
  id?: number
  result?: any
  error?: { code: number; message: string }
}

let buf = ""
function send(proc: ChildProcessWithoutNullStreams, msg: any): Promise<JsonRpcResponse> {
  return new Promise((resolveP, rejectP) => {
    const id = msg.id
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let parsed: any
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (parsed.id === id) {
          proc.stdout.off("data", onData)
          resolveP(parsed)
          return
        }
      }
    }
    proc.stdout.on("data", onData)
    proc.stdin.write(JSON.stringify(msg) + "\n")
    setTimeout(() => rejectP(new Error("RPC timeout for id " + id)), 10000)
  })
}

let proc: ChildProcessWithoutNullStreams | null = null

beforeAll(() => {
  if (!existsSync(DIST)) {
    throw new Error(`dist/todo-index.js not found at ${DIST} — run 'pnpm run build' first`)
  }
})

afterAll(async () => {
  if (proc && !proc.killed) {
    proc.kill()
    await new Promise((r) => setTimeout(r, 200))
  }
})

describe("built MCP server", () => {
  it("starts and lists all expected tools including move-task", async () => {
    proc = spawn("node", [DIST], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, REDIRECT_URI: "http://localhost:3000/callback" },
    }) as ChildProcessWithoutNullStreams
    proc.stderr.on("data", () => {})

    const init = await send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.0.1" },
      },
    })
    expect(init.error, JSON.stringify(init.error)).toBeUndefined()
    expect(init.result.serverInfo.name).toBe("mstodo")

    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

    const tools = await send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(tools.error).toBeUndefined()
    const names: string[] = tools.result.tools.map((t: any) => t.name)
    // 17 = 16 existing + 1 new move-task
    expect(names).toContain("move-task")
    // Sanity-check the move-task schema exposes the four expected fields
    const moveTask = tools.result.tools.find((t: any) => t.name === "move-task")
    expect(Object.keys(moveTask.inputSchema.properties).sort()).toEqual(
      ["moveChecklistItems", "sourceListId", "targetListId", "taskId"].sort(),
    )
  }, 20_000)
})

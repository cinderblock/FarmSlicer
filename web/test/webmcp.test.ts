import { describe, expect, test } from "bun:test";
import { callTool, pageTool, setWebMcpSignedIn, type ModelContextLike, type PageTool } from "../src/webmcp";

const listed = {
  tools: [
    { name: "list_jobs", title: "List jobs", description: "Jobs.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "control_print", description: "Stop.", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
  ],
};

/** A fake server: the tool list, and calls answered by `answer`. */
function server(answer: (body: { name: string; arguments: unknown }) => { status?: number; body: unknown }) {
  const calls: unknown[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === "/api/mcp/tools") return new Response(JSON.stringify(listed));
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const a = answer(body);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** A fake `document.modelContext` that honours the abort signal. */
function browser() {
  const tools = new Map<string, PageTool>();
  const mc: ModelContextLike = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => tools.delete(tool.name));
    },
  };
  return { mc, tools };
}

describe("WebMCP", () => {
  test("a signed-in page offers the server's tools, and signing out takes them back", async () => {
    const { mc, tools } = browser();
    const { fetcher } = server(() => ({ body: {} }));
    await setWebMcpSignedIn(true, mc, fetcher);
    expect([...tools.keys()]).toEqual(["list_jobs", "control_print"]);
    expect(tools.get("list_jobs")!.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true, consequentialHint: false });
    expect(tools.get("control_print")!.annotations.consequentialHint).toBe(true);
    await setWebMcpSignedIn(false, mc, fetcher);
    expect(tools.size).toBe(0);
  });

  test("signing in again doesn't register twice", async () => {
    const { mc, tools } = browser();
    const { fetcher } = server(() => ({ body: {} }));
    await setWebMcpSignedIn(true, mc, fetcher);
    await setWebMcpSignedIn(true, mc, fetcher);
    expect(tools.size).toBe(2);
  });

  test("a call runs on the server; lists come back unwrapped", async () => {
    const { fetcher, calls } = server(() => ({
      body: { content: [{ type: "text", text: "[1]" }], isError: false, structuredContent: { items: [{ id: "j1" }] } },
    }));
    const tool = pageTool(listed.tools[0], (n, i) => callTool(n, i, fetcher));
    expect(await tool.execute({ limit: 1 })).toEqual([{ id: "j1" }]);
    expect(calls).toEqual([{ name: "list_jobs", arguments: { limit: 1 } }]);
  });

  test("a tool error rejects with its message", async () => {
    const { fetcher } = server(() => ({ body: { content: [{ type: "text", text: "job not found (HTTP 404)" }], isError: true } }));
    await expect(callTool("get_job", {}, fetcher)).rejects.toThrow("job not found (HTTP 404)");
    const refused = server(() => ({ status: 403, body: { error: "tools run from FarmSlicer's own pages only" } }));
    await expect(callTool("get_job", {}, refused.fetcher)).rejects.toThrow("own pages only");
  });
});

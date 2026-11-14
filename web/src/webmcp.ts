// WebMCP: the signed-in page offers FarmSlicer's agent tools to an AI agent
// in the browser (`document.modelContext`, W3C Web Machine Learning CG
// draft; Chrome origin trial). The tools are the server's MCP tools
// (src/mcp.rs): their list comes from `GET /api/mcp/tools`, and each call
// runs on the server with this page's session (`POST /api/mcp/call`), so
// an agent here can do what the signed-in account can, and nothing more.
// Plan: plans/slicer-upload-and-mcp.md.

/** A tool as `GET /api/mcp/tools` lists it (MCP's tools/list shape). */
export interface ServerTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** The part of the draft's `ModelContextTool` FarmSlicer fills in. */
export interface PageTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean; consequentialHint: boolean };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ModelContextLike {
  registerTool(tool: PageTool, options?: { signal?: AbortSignal }): unknown;
}

/** `document.modelContext`, or `navigator.modelContext` in builds from before the draft moved it. */
export function modelContext(): ModelContextLike | undefined {
  const found =
    (document as unknown as { modelContext?: ModelContextLike }).modelContext ??
    (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  return typeof found?.registerTool === "function" ? found : undefined;
}

/** A server tool as the browser takes it, its calls going to `call`. */
export function pageTool(t: ServerTool, call: (name: string, input: Record<string, unknown>) => Promise<unknown>): PageTool {
  const readOnly = t.annotations?.readOnlyHint === true;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      // Job, project, and printer names are whatever people typed.
      untrustedContentHint: true,
      consequentialHint: !readOnly,
    },
    execute: (input) => call(t.name, input ?? {}),
  };
}

/** One tool call on the server; a tool error rejects with its message. */
export async function callTool(name: string, input: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<unknown> {
  const res = await fetcher("/api/mcp/call", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: input }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  const text: string = body?.content?.[0]?.text ?? "";
  if (body?.isError) throw new Error(text || "the tool failed");
  const structured = body?.structuredContent;
  if (structured === undefined) return text;
  // Lists come wrapped for MCP (structured content is an object).
  return Object.keys(structured).length === 1 && Array.isArray(structured.items) ? structured.items : structured;
}

let current: AbortController | null = null;
let generation = 0;

/**
 * Register the account's tools while someone is signed in, and take them
 * back when they sign out. Does nothing in a browser without WebMCP.
 */
export async function setWebMcpSignedIn(signedIn: boolean, mc: ModelContextLike | undefined = modelContext(), fetcher: typeof fetch = fetch) {
  if (!mc) return;
  const mine = ++generation;
  current?.abort();
  current = null;
  if (!signedIn) return;
  const res = await fetcher("/api/mcp/tools", { credentials: "same-origin" }).catch(() => null);
  if (!res?.ok || mine !== generation) return;
  const { tools } = (await res.json()) as { tools: ServerTool[] };
  if (mine !== generation) return;
  const controller = new AbortController();
  current = controller;
  for (const t of tools) {
    try {
      const handle = await mc.registerTool(pageTool(t, (name, input) => callTool(name, input, fetcher)), {
        signal: controller.signal,
      });
      // Early builds returned a handle to unregister with instead of taking a signal.
      const unregister = (handle as { unregister?: () => void } | undefined)?.unregister;
      if (typeof unregister === "function") controller.signal.addEventListener("abort", () => unregister.call(handle));
    } catch (err) {
      console.debug(`WebMCP: the browser didn't take the tool ${t.name}:`, err);
    }
  }
}

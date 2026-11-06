/**
 * Deterministic local OpenAI-compatible mock provider for automated tests ONLY.
 * No external provider is contacted; costs are zero. Supports directives embedded
 * in the last user message:
 *   [delay:MS]   stretch the response over MS milliseconds
 *   [tokens:N]   emit N text chunks
 *   [tool:NAME:JSONARGS]  emit a tool call (NAME may contain no colons; JSON last)
 *   [failonce]   first request fails with 500, next succeeds (retry tests)
 */
import http from "node:http";

export interface MockProvider {
  url: string;
  port: number;
  close(): Promise<void>;
  requests: { body: unknown; at: number }[];
}

export async function startMockProvider(): Promise<MockProvider> {
  const requests: { body: unknown; at: number }[] = [];
  const failedOnce = new Set<string>();
  const toolsConsumed = new Set<string>();
  const server = http.createServer((req, res) => {
    if (!req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", async () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch { /* keep empty */ }
      requests.push({ body, at: Date.now() });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((c: any) => c.text ?? "").join("") : "";
      let directives = parseDirectives(text);
      // A tool directive must fire exactly once per user message: subsequent requests in the
      // same run still contain that user message, and re-emitting the call would loop forever.
      const toolKey = `tool::${text}`;
      if (directives.has("tool")) {
        if (toolsConsumed.has(toolKey)) {
          directives = new Map(directives);
          directives.delete("tool");
        } else {
          toolsConsumed.add(toolKey);
        }
      }
      if (directives.has("failonce")) {
        const key = String(directives.get("failonce"));
        if (!failedOnce.has(key)) {
          failedOnce.add(key);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "mock transient failure" } }));
          return;
        }
      }
      const delay = Number(directives.get("delay") ?? 300);
      const tokens = Number(directives.get("tokens") ?? 6);
      const toolSpec = directives.get("tool");
      const isStreaming = body.stream === true;
      const replyText = `Mock reply to: ${text.replace(/\[[a-z]+:[^\]]*\]/g, "").trim().slice(0, 80) || "(empty)"}`;
      const model = String(body.model ?? "mock-echo");

      if (!isStreaming) {
        const message: Record<string, unknown> = { role: "assistant", content: replyText };
        if (toolSpec) {
          const { name, args } = parseToolSpec(toolSpec);
          message.tool_calls = [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
          message.content = null;
        }
        await sleep(delay);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `mock-${Date.now()}`, object: "chat.completion", created: 0, model,
          choices: [{ index: 0, message, finish_reason: toolSpec ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: tokens, total_tokens: 10 + tokens },
        }));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (obj: unknown) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      const id = `mock-${Date.now()}`;
      const chunkBase = { id, object: "chat.completion.chunk", created: 0, model };
      send({ ...chunkBase, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (toolSpec) {
        const { name, args } = parseToolSpec(toolSpec);
        const callId = `call_${Math.random().toString(36).slice(2, 8)}`;
        send({ ...chunkBase, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] });
        const argStr = JSON.stringify(args);
        const step = Math.max(1, Math.ceil(argStr.length / 4));
        for (let i = 0; i < argStr.length; i += step) {
          await sleep(Math.min(30, delay / 6));
          send({ ...chunkBase, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(i, i + step) } }] }, finish_reason: null }] });
        }
        send({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        const words = replyText.match(/.{1,12}/gs) ?? [replyText];
        const per = Math.max(1, Math.floor(delay / Math.max(1, words.length)));
        for (const w of words.slice(0, Math.max(1, tokens * 4))) {
          await sleep(per);
          send({ ...chunkBase, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
        }
        send({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(Number(process.env.PIWEB_MOCK_PORT || 0), "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

function parseDirectives(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\[([a-z]+):([^\]]*)\]/g)) out.set(m[1]!, m[2]!);
  return out;
}

function parseToolSpec(spec: string): { name: string; args: Record<string, unknown> } {
  const firstColon = spec.indexOf(":");
  const name = spec.slice(0, firstColon);
  try { return { name, args: JSON.parse(spec.slice(firstColon + 1)) }; } catch { return { name, args: {} }; }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** models.json content registering the mock provider for a temp agent dir. */
export function mockModelsJson(url: string): string {
  return JSON.stringify({
    providers: {
      mock: {
        name: "Mock Local",
        baseUrl: url,
        api: "openai-completions",
        apiKey: "mock-key",
        authHeader: true,
        models: [
          { id: "mock-echo", name: "Mock Echo", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 },
          { id: "mock-echo-2", name: "Mock Echo 2", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 },
        ],
      },
    },
  }, null, 2);
}

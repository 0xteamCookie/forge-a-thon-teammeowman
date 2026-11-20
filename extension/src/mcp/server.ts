// Loopback MCP server: the editor's capabilities, exposed as tools that the TrueForge agent
// decides when to call. Read tools are annotated readOnlyHint so they run freely; write and
// command tools are annotated as writes, so TrueForge's approval gate pauses on them, and the
// extension turns that pause into the per-hunk diff review.
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** Implemented by the extension; keeps this module free of vscode imports. */
export interface EditorBridge {
  readFile(path: string, startLine?: number, endLine?: number): Promise<ToolResult>;
  listFiles(dir?: string, pattern?: string): Promise<ToolResult>;
  searchCode(query: string, isRegex: boolean, pathGlob?: string, maxResults?: number): Promise<ToolResult>;
  findSymbol(name: string): Promise<ToolResult>;
  retrieveContext(query: string, budgetTokens?: number): Promise<ToolResult>;
  /** Execute a reviewed write. `args` are the exact arguments the user reviewed. */
  executeWrite(tool: 'edit_file' | 'write_file', args: Record<string, unknown>): Promise<ToolResult>;
  runCommand(command: string, cwd?: string): Promise<ToolResult>;
  onToolCall?(name: string, args: Record<string, unknown>): void;
}

export const SERVER_NAME = 'anvil-editor';

type Json = Record<string, unknown>;
interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json & { type: 'object'; properties: Json; required?: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(bridge: EditorBridge, a: Json): Promise<ToolResult>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const str = (description?: string): Json => (description ? { type: 'string', description } : { type: 'string' });
const int = (description?: string): Json => (description ? { type: 'integer', minimum: 1, description } : { type: 'integer', minimum: 1 });
const s = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Plain JSON Schema tool table: explicit, and identical to what TrueForge shows in the session. */
export const TOOLS: ToolDef[] = [
  {
    name: 'retrieve_context',
    title: 'Retrieve relevant code',
    description:
      'Rank the workspace for code relevant to a natural-language query and return the best files/chunks with the reason each was chosen, packed under a token budget. Use this first to find where a change belongs when the user did not name files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('What you are looking for, in plain words plus any identifiers.'),
        budget_tokens: { type: 'integer', minimum: 500, maximum: 30000, description: 'Max tokens of code to return (default 6000).' },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
    run: (b, a) => b.retrieveContext(s(a.query), n(a.budget_tokens)),
  },
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a workspace file with 1-based line numbers, optionally a line range. Always read a file before editing it.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Workspace-relative path, e.g. src/flask/cli.py'), start_line: int(), end_line: int() },
      required: ['path'],
    },
    annotations: READ_ONLY,
    run: (b, a) => b.readFile(s(a.path), n(a.start_line), n(a.end_line)),
  },
  {
    name: 'search_code',
    title: 'Search code',
    description: 'Search workspace files for a literal string or a regular expression. Returns path:line: text matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str(),
        is_regex: { type: 'boolean' },
        path_glob: str('Limit to paths matching this glob, e.g. "tests/**" or "*.rst"'),
        max_results: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
    run: (b, a) => b.searchCode(s(a.query), a.is_regex === true, typeof a.path_glob === 'string' ? a.path_glob : undefined, n(a.max_results)),
  },
  {
    name: 'find_symbol',
    title: 'Find symbol',
    description: 'Find where a function, class, method or module-level name is defined, with its signature and the files that reference it.',
    inputSchema: { type: 'object', properties: { name: str() }, required: ['name'] },
    annotations: READ_ONLY,
    run: (b, a) => b.findSymbol(s(a.name)),
  },
  {
    name: 'list_files',
    title: 'List files',
    description: 'List workspace files, optionally under a directory and/or matching a glob.',
    inputSchema: { type: 'object', properties: { dir: str(), pattern: str() } },
    annotations: READ_ONLY,
    run: (b, a) => b.listFiles(typeof a.dir === 'string' ? a.dir : undefined, typeof a.pattern === 'string' ? a.pattern : undefined),
  },
  {
    name: 'edit_file',
    title: 'Edit file',
    description:
      'Propose edits to an existing file as exact search/replace pairs. Each old_string must appear exactly once in the current file, copied verbatim including indentation. Put all edits for one file in a single call. The user reviews every hunk before anything is written; the result tells you which hunks were accepted or rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str(),
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { old_string: str('Exact existing text to replace'), new_string: str('Replacement text') },
            required: ['old_string', 'new_string'],
          },
        },
        explanation: str('One sentence on why, shown to the reviewer.'),
      },
      required: ['path', 'edits', 'explanation'],
    },
    annotations: WRITE,
    run: (b, a) => b.executeWrite('edit_file', a),
  },
  {
    name: 'write_file',
    title: 'Write file',
    description:
      'Create a new file, or replace a whole file when most of it changes. Prefer edit_file for changes to existing files. The user reviews before anything is written.',
    inputSchema: { type: 'object', properties: { path: str(), content: str(), explanation: str() }, required: ['path', 'content', 'explanation'] },
    annotations: WRITE,
    run: (b, a) => b.executeWrite('write_file', a),
  },
  {
    name: 'run_command',
    title: 'Run terminal command',
    description: 'Run a shell command in the workspace (e.g. the test suite) and return its exit code and output. Requires user approval.',
    inputSchema: { type: 'object', properties: { command: str(), cwd: str('Workspace-relative directory') }, required: ['command'] },
    annotations: { ...WRITE, destructiveHint: true },
    run: (b, a) => b.runCommand(s(a.command), typeof a.cwd === 'string' ? a.cwd : undefined),
  },
];

export function buildMcpServer(bridge: EditorBridge): Server {
  const server = new Server({ name: SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const tool = TOOLS.find(t => t.name === req.params.name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
    const args = (req.params.arguments ?? {}) as Json;
    bridge.onToolCall?.(tool.name, args);
    try {
      const r = await tool.run(bridge, args);
      return { content: [{ type: 'text', text: r.text }], isError: r.isError ?? false };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  });
  return server;
}
export interface RunningMcp {
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * Stateless streamable-HTTP MCP endpoint on 127.0.0.1 only, guarded by a per-launch bearer
 * token so other local processes cannot drive the editor.
 */
export async function startMcpHttp(bridge: EditorBridge, port: number, log: (m: string) => void): Promise<RunningMcp> {
  const token = randomBytes(24).toString('hex');
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const server = buildMcpServer(bridge);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`MCP request failed: ${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  const actual = (httpServer.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${actual}/mcp`,
    token,
    // TrueForge keeps a keep-alive connection open; close() alone would wait on it forever.
    close: () =>
      new Promise(r => {
        httpServer.close(() => r());
        httpServer.closeAllConnections();
      }),
  };
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Stable key for "this exact tool call": the approval and the later execution must match. */
export function callKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${canonical(args)}`;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

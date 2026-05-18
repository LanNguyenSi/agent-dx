import type { FileOptions, FileResult, Friction, Priority, RenderedTemplate, Sink } from '../types.js';

export interface AgentTasksOpts {
  /** Defaults to "rest". "mcp-emit" prints the equivalent
   * mcp__agent-tasks__task_create JSON to stdout instead of POSTing.
   */
  mode: 'rest' | 'mcp-emit';
  projectId?: string;
  /** REST base URL, e.g. https://agent-tasks.opentriologue.ai */
  apiBase?: string;
  /** Bearer token. Defaults to env var AGENT_TASKS_TOKEN. */
  token?: string;
  priority?: Priority;
  labels?: string[];
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type StdoutWriter = (line: string) => void;

/**
 * agent-tasks sink. Two paths, both supported per spec:
 *
 *   - mode=rest (default): POST /api/projects/<id>/tasks with the friction's
 *     rendered title/body, returns the new task UUID as external_ref.
 *   - mode=mcp-emit: print the equivalent mcp__agent-tasks__task_create JSON
 *     to stdout for an agent harness to pick up and execute. No network call
 *     is made. Useful when friction-log is run inside a Claude Code session
 *     where the agent already holds the MCP scope.
 *
 * mcp-emit is the honest version of "the MCP path" for a standalone Node CLI:
 * it doesn't pretend to speak MCP, it just emits the structured intent.
 */
export class AgentTasksSink implements Sink {
  readonly name = 'agent-tasks';

  constructor(
    private readonly fetchImpl: Fetcher = (url, init) => fetch(url, init),
    private readonly write: StdoutWriter = (line) => process.stdout.write(line)
  ) {}

  async file(friction: Friction, rendered: RenderedTemplate, opts: FileOptions): Promise<FileResult> {
    const parsed = parseOpts(opts);
    const payload = buildPayload(friction, rendered, parsed);

    if (parsed.mode === 'mcp-emit') {
      const intent = {
        tool: 'mcp__agent-tasks__task_create',
        params: payload,
      };
      this.write(JSON.stringify(intent) + '\n');
      return {
        ok: true,
        sinkTarget: `agent-tasks:mcp-emit:${payload.projectId}`,
        message: 'emitted MCP task_create intent to stdout (no network call)',
      };
    }

    const apiBase = parsed.apiBase;
    if (!apiBase) {
      throw new Error(
        `friction-log: agent-tasks sink in REST mode requires "apiBase". Set sinks.agent-tasks.apiBase in config.yml or pass --sink-opt apiBase=https://...`
      );
    }
    const token = parsed.token ?? process.env.AGENT_TASKS_TOKEN;
    if (!token) {
      throw new Error(
        `friction-log: agent-tasks REST mode requires a token. Set AGENT_TASKS_TOKEN env var or sinks.agent-tasks.token.`
      );
    }
    const url = `${apiBase.replace(/\/$/, '')}/api/projects/${encodeURIComponent(payload.projectId)}/tasks`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: payload.title,
        description: payload.description,
        priority: payload.priority,
        labels: payload.labels,
      }),
    });
    if (!response.ok) {
      const body = await safeText(response);
      throw new Error(
        `friction-log: agent-tasks REST returned ${response.status}: ${body.slice(0, 400)}`
      );
    }
    const parsedBody = (await response.json()) as { task?: { id?: string }; id?: string };
    const taskId = parsedBody.task?.id ?? parsedBody.id;
    if (typeof taskId !== 'string') {
      throw new Error(
        `friction-log: agent-tasks REST response missing task id: ${JSON.stringify(parsedBody).slice(0, 400)}`
      );
    }
    return {
      ok: true,
      sinkTarget: `agent-tasks:${payload.projectId}`,
      externalRef: taskId,
      message: `created task ${taskId}`,
    };
  }
}

interface AgentTasksPayload {
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  labels: string[];
}

function buildPayload(
  friction: Friction,
  rendered: RenderedTemplate,
  opts: AgentTasksOpts
): AgentTasksPayload {
  if (!opts.projectId) {
    throw new Error(
      `friction-log: agent-tasks sink requires "projectId" (uuid). Set sinks.agent-tasks.projectId in config.yml or pass --sink-opt projectId=...`
    );
  }
  const labels = Array.from(new Set([...(opts.labels ?? []), ...rendered.labels]));
  const description = renderDescription(friction, rendered);
  return {
    projectId: opts.projectId,
    title: rendered.title,
    description,
    priority: opts.priority ?? rendered.priority,
    labels,
  };
}

function parseOpts(opts: FileOptions): AgentTasksOpts {
  const raw = opts.sinkOpts ?? {};
  const mode = parseMode(raw.mode);
  const projectId = optionalString(raw.projectId, 'projectId');
  const apiBase = optionalString(raw.apiBase, 'apiBase');
  const token = optionalString(raw.token, 'token');
  const priority = parsePriority(raw.priority);
  const labels = parseStringList(raw.labels, 'labels');
  return { mode, projectId, apiBase, token, priority, labels };
}

function parseMode(value: unknown): 'rest' | 'mcp-emit' {
  if (value == null) return 'rest';
  if (value === 'rest' || value === 'mcp-emit') return value;
  throw new Error(
    `friction-log: agent-tasks "mode" must be "rest" or "mcp-emit", got ${JSON.stringify(value)}`
  );
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`friction-log: agent-tasks "${name}" must be a string`);
}

function parsePriority(value: unknown): Priority | undefined {
  if (value == null) return undefined;
  const valid: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (typeof value === 'string' && (valid as string[]).includes(value)) return value as Priority;
  throw new Error(
    `friction-log: agent-tasks "priority" must be one of ${valid.join('|')}`
  );
}

function parseStringList(value: unknown, name: string): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new Error(`friction-log: agent-tasks "${name}" must be a string or array of strings`);
}

function renderDescription(friction: Friction, rendered: RenderedTemplate): string {
  const meta: string[] = [];
  meta.push(`friction-log id ${friction.id} captured ${friction.capturedAt}`);
  if (friction.toolSurface) meta.push(`tool: ${friction.toolSurface}`);
  if (friction.category) meta.push(`category: ${friction.category}`);
  if (friction.severity) meta.push(`severity: ${friction.severity}`);
  if (friction.recurrenceOfId != null) meta.push(`recurrence of friction #${friction.recurrenceOfId}`);
  return `${rendered.body}\n\n---\n${meta.join('\n')}\n`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(no body)';
  }
}

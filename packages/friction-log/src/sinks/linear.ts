import type { FileOptions, FileResult, Friction, RenderedTemplate, Sink } from '../types.js';

export interface LinearOpts {
  teamId: string;
  state?: string;
  assignee?: string;
  /** LINEAR_API_KEY env var by default. */
  apiKey?: string;
  /** Default https://api.linear.app/graphql. */
  endpoint?: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const ISSUE_CREATE_MUTATION = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`.trim();

/**
 * Create a Linear issue via GraphQL. LINEAR_API_KEY env var supplies the
 * personal access token by default; teamId is required.
 *
 * The `state` option is matched case-insensitively against the team's
 * workflow-state names so callers can write "Backlog" instead of a UUID.
 * Looking up the workflow state requires one extra query, kept minimal.
 */
export class LinearSink implements Sink {
  readonly name = 'linear';

  constructor(private readonly fetchImpl: Fetcher = (url, init) => fetch(url, init)) {}

  async file(friction: Friction, rendered: RenderedTemplate, opts: FileOptions): Promise<FileResult> {
    const parsed = parseOpts(opts);
    const apiKey = parsed.apiKey ?? process.env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new Error(
        `friction-log: linear sink requires an API key. Set LINEAR_API_KEY env var or sinks.linear.apiKey.`
      );
    }
    const endpoint = parsed.endpoint ?? 'https://api.linear.app/graphql';

    const stateId = parsed.state
      ? isUuid(parsed.state)
        ? parsed.state
        : await resolveStateId(this.fetchImpl, endpoint, apiKey, parsed.teamId, parsed.state)
      : undefined;

    const input: Record<string, unknown> = {
      teamId: parsed.teamId,
      title: rendered.title,
      description: renderDescription(friction, rendered),
      labelIds: undefined,
    };
    if (stateId) input.stateId = stateId;
    if (parsed.assignee) input.assigneeId = parsed.assignee;

    const variables = { input };
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: apiKey,
      },
      body: JSON.stringify({ query: ISSUE_CREATE_MUTATION, variables }),
    });
    if (!response.ok) {
      const body = await safeText(response);
      throw new Error(`friction-log: linear API returned ${response.status}: ${body.slice(0, 400)}`);
    }
    const json = (await response.json()) as {
      data?: { issueCreate?: { success?: boolean; issue?: { id?: string; identifier?: string; url?: string } } };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      throw new Error(
        `friction-log: linear API errors: ${json.errors.map((e) => e.message ?? '(no message)').join('; ')}`
      );
    }
    const issue = json.data?.issueCreate?.issue;
    if (!json.data?.issueCreate?.success || !issue?.id || !issue.identifier || !issue.url) {
      throw new Error(`friction-log: linear issueCreate did not return a complete issue: ${JSON.stringify(json).slice(0, 400)}`);
    }
    return {
      ok: true,
      sinkTarget: `linear:${parsed.teamId}`,
      externalRef: issue.url,
      message: `created ${issue.identifier} (${issue.url})`,
    };
  }
}

const WORKFLOW_STATES_QUERY = `
query WorkflowStates($teamId: String!) {
  team(id: $teamId) {
    states { nodes { id name } }
  }
}`.trim();

async function resolveStateId(
  fetchImpl: Fetcher,
  endpoint: string,
  apiKey: string,
  teamId: string,
  stateName: string
): Promise<string> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: apiKey,
    },
    body: JSON.stringify({ query: WORKFLOW_STATES_QUERY, variables: { teamId } }),
  });
  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(`friction-log: linear state lookup ${response.status}: ${body.slice(0, 400)}`);
  }
  const json = (await response.json()) as {
    data?: { team?: { states?: { nodes?: Array<{ id?: string; name?: string }> } } };
    errors?: Array<{ message?: string }>;
  };
  if (json.errors?.length) {
    throw new Error(`friction-log: linear state lookup errors: ${json.errors.map((e) => e.message ?? '(no message)').join('; ')}`);
  }
  const nodes = json.data?.team?.states?.nodes ?? [];
  const wanted = stateName.toLowerCase();
  const match = nodes.find((n) => n.name?.toLowerCase() === wanted);
  if (!match?.id) {
    const known = nodes.map((n) => n.name).filter(Boolean).join(', ');
    throw new Error(`friction-log: linear team ${teamId} has no state matching "${stateName}". Known: ${known || '(none)'}`);
  }
  return match.id;
}

function parseOpts(opts: FileOptions): LinearOpts {
  const raw = opts.sinkOpts ?? {};
  const teamId = raw.teamId;
  if (typeof teamId !== 'string' || !teamId) {
    throw new Error(
      `friction-log: linear sink requires "teamId". Set sinks.linear.teamId in config.yml or pass --sink-opt teamId=...`
    );
  }
  const state = optionalString(raw.state, 'state');
  const assignee = optionalString(raw.assignee, 'assignee');
  const apiKey = optionalString(raw.apiKey, 'apiKey');
  const endpoint = optionalString(raw.endpoint, 'endpoint');
  return { teamId, state, assignee, apiKey, endpoint };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`friction-log: linear "${name}" must be a string`);
}

function renderDescription(friction: Friction, rendered: RenderedTemplate): string {
  const meta: string[] = [];
  meta.push(`friction-log id ${friction.id} captured ${friction.capturedAt}`);
  if (friction.toolSurface) meta.push(`tool: \`${friction.toolSurface}\``);
  if (friction.category) meta.push(`category: ${friction.category}`);
  if (friction.severity) meta.push(`severity: ${friction.severity}`);
  if (friction.recurrenceOfId != null) meta.push(`recurrence of friction #${friction.recurrenceOfId}`);
  return `${rendered.body}\n\n---\n${meta.join('  \n')}\n`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(no body)';
  }
}

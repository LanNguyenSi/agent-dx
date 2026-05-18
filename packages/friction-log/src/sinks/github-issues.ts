import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { FileOptions, FileResult, Friction, RenderedTemplate, Sink } from '../types.js';

export interface GithubIssuesOpts {
  repo: string;
  labels?: string[];
  assignee?: string;
  milestone?: string;
}

export type GhRunner = (args: string[], input: string) => SpawnSyncReturns<string>;

const defaultRunner: GhRunner = (args, input) =>
  spawnSync('gh', args, {
    input,
    encoding: 'utf8',
  });

/**
 * Create a GitHub issue by spawning `gh issue create`. No HTTP client in the
 * package: gh handles auth, retries, and proxy config. Required option `repo`
 * is owner/name; everything else is optional.
 */
export class GithubIssuesSink implements Sink {
  readonly name = 'github-issues';

  constructor(private readonly runGh: GhRunner = defaultRunner) {}

  async file(friction: Friction, rendered: RenderedTemplate, opts: FileOptions): Promise<FileResult> {
    const parsed = parseOpts(opts);
    const labels = Array.from(new Set([...(parsed.labels ?? []), ...rendered.labels]));
    const args = [
      'issue',
      'create',
      '--repo',
      parsed.repo,
      '--title',
      rendered.title,
      '--body-file',
      '-',
    ];
    for (const label of labels) {
      args.push('--label', label);
    }
    if (parsed.assignee) args.push('--assignee', parsed.assignee);
    if (parsed.milestone) args.push('--milestone', parsed.milestone);

    const body = renderBody(friction, rendered);
    const result = this.runGh(args, body);

    if (result.error) {
      throw new Error(`friction-log: gh CLI not runnable: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').trim();
      throw new Error(`friction-log: gh issue create failed (exit ${result.status}): ${stderr || 'no stderr'}`);
    }
    const issueUrl = (result.stdout ?? '').trim().split('\n').pop() ?? '';
    if (!/^https:\/\/github\.com\//.test(issueUrl)) {
      throw new Error(`friction-log: gh stdout did not contain an issue URL: ${result.stdout}`);
    }
    return {
      ok: true,
      sinkTarget: parsed.repo,
      externalRef: issueUrl,
      message: `created ${issueUrl}`,
    };
  }
}

function parseOpts(opts: FileOptions): GithubIssuesOpts {
  const raw = opts.sinkOpts ?? {};
  const repo = raw.repo;
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(
      `friction-log: github-issues sink requires "repo" (owner/name). Set sinks.github-issues.repo in config.yml or pass --sink-opt repo=owner/name.`
    );
  }
  const labels = normalizeStringList(raw.labels, 'labels');
  const assignee = optionalString(raw.assignee, 'assignee');
  const milestone = optionalString(raw.milestone, 'milestone');
  return { repo, labels, assignee, milestone };
}

function normalizeStringList(value: unknown, name: string): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new Error(`friction-log: github-issues "${name}" must be a string or array of strings`);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`friction-log: github-issues "${name}" must be a string`);
}

function renderBody(friction: Friction, rendered: RenderedTemplate): string {
  const meta: string[] = [];
  meta.push(`<sub>friction-log id ${friction.id} captured ${friction.capturedAt}</sub>`);
  if (friction.toolSurface) meta.push(`<sub>tool: \`${friction.toolSurface}\`</sub>`);
  if (friction.category) meta.push(`<sub>category: ${friction.category}</sub>`);
  if (friction.severity) meta.push(`<sub>severity: ${friction.severity}</sub>`);
  if (friction.recurrenceOfId != null) meta.push(`<sub>recurrence of friction #${friction.recurrenceOfId}</sub>`);
  return `${rendered.body}\n\n---\n${meta.join('  \n')}\n`;
}

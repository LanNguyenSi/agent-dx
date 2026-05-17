import { FrictionDb } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { loadScanner } from '../scanners/index.js';
import type { Friction, Session, Task } from '../types.js';

export interface BilanzCommandInput {
  sessionId?: string;
  dbPath?: string;
}

export interface BilanzCommandOutput {
  session: Session;
  toolsExercised: string[];
  frictions: Array<Friction & { tasks: Task[] }>;
  formatted: string;
}

export async function runBilanz(input: BilanzCommandInput): Promise<BilanzCommandOutput> {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const session = input.sessionId ? db.getSession(input.sessionId) : db.getMostRecentSession();
    if (!session) {
      throw new Error(
        input.sessionId
          ? `friction-log: session ${input.sessionId} not found in db`
          : `friction-log: no sessions in db yet. Run friction-log scan first.`
      );
    }

    const frictions = db.listFrictionsForSession(session.id);
    const withTasks = frictions.map((f) => ({ ...f, tasks: db.listTasksForFriction(f.id) }));

    const toolsExercised = await extractToolsExercised(session);

    const formatted = formatBilanz({ session, toolsExercised, frictions: withTasks });
    return { session, toolsExercised, frictions: withTasks, formatted };
  } finally {
    db.close();
  }
}

async function extractToolsExercised(session: Session): Promise<string[]> {
  if (!session.transcriptPath) return [];
  try {
    const scanner = loadScanner(session.adapter);
    const result = await scanner.scan({
      sessionId: session.id,
      transcriptPath: session.transcriptPath,
    });
    const tools = new Set<string>();
    for (const c of result.frictionCandidates) {
      if (c.toolSurface) tools.add(c.toolSurface);
    }
    return [...tools].sort();
  } catch {
    return [];
  }
}

interface BilanzInput {
  session: Session;
  toolsExercised: string[];
  frictions: Array<Friction & { tasks: Task[] }>;
}

export function formatBilanz(b: BilanzInput): string {
  const lines: string[] = [];
  lines.push(`## Dogfood bilanz`);
  lines.push('');
  lines.push(`Session: \`${b.session.id}\` (${b.session.startedAt}${b.session.endedAt ? ` to ${b.session.endedAt}` : ''})`);
  if (b.session.projectPaths && b.session.projectPaths.length > 0) {
    lines.push(`Project paths: ${b.session.projectPaths.map((p) => `\`${p}\``).join(', ')}`);
  }
  lines.push('');

  lines.push(`**Tools exercised** (${b.toolsExercised.length}):`);
  if (b.toolsExercised.length === 0) {
    lines.push('  _none captured by the scan adapter_');
  } else {
    for (const t of b.toolsExercised) {
      lines.push(`  - ${t}`);
    }
  }
  lines.push('');

  const filed = b.frictions.filter((f) => f.tasks.length > 0);
  const unfiled = b.frictions.filter((f) => f.tasks.length === 0 && f.status === 'open');

  lines.push(`**Frictions noticed** (${b.frictions.length}):`);
  if (b.frictions.length === 0) {
    lines.push('  _none recorded for this session_');
  } else {
    for (const f of b.frictions) {
      const marker = f.tasks.length > 0 ? 'filed' : f.status;
      lines.push(`  - [${marker}] id=${f.id} ${f.toolSurface ? `(${f.toolSurface}) ` : ''}${f.title}`);
    }
  }
  lines.push('');

  lines.push(`**Tasks filed** (${filed.length}):`);
  if (filed.length === 0) {
    lines.push('  _none yet_');
  } else {
    for (const f of filed) {
      for (const t of f.tasks) {
        const ref = t.externalRef ?? t.sinkTarget ?? '?';
        lines.push(`  - friction id=${f.id} -> ${t.sinkName}: ${ref}`);
      }
    }
  }
  lines.push('');

  if (unfiled.length > 0) {
    lines.push(`**Open frictions without a filed task** (${unfiled.length}) -- consider \`friction-log file <id>\`:`);
    for (const f of unfiled) {
      lines.push(`  - id=${f.id} ${f.toolSurface ? `(${f.toolSurface}) ` : ''}${f.title}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Scanner, ScannerInput, ScannerOutput } from '../types.js';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | ToolResultBlock | TextBlock | { type: string; [k: string]: unknown };

interface MessageEntry {
  type: 'user' | 'assistant';
  message?: {
    role: string;
    content?: string | ContentBlock[];
  };
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  uuid?: string;
}

interface PermissionEntry {
  type: 'permission-mode';
  sessionId?: string;
}

type TranscriptEntry = MessageEntry | PermissionEntry | { type: string; [k: string]: unknown };

const FRICTION_PHRASE_PATTERNS: RegExp[] = [
  /\bdidn['']?t work\b/i,
  /\bdoesn['']?t work\b/i,
  /\bnot working\b/i,
  /\bunexpected(ly)?\b/i,
  /\bblocked by\b/i,
  /\bfunktioniert nicht\b/i,
  /\bklappt nicht\b/i,
  /\bunerwartet\b/i,
  /\bschl[äa]gt fehl\b/i,
];

const MAX_PHRASE_LINE_CHARS = 280;

interface RawFrictionCandidate {
  toolSurface: string | null;
  title: string;
  description: string | null;
  severity: 'low' | 'medium' | 'high' | null;
  category: string;
}

export class ClaudeCodeAdapter implements Scanner {
  readonly name = 'claude-code';

  async scan(input: ScannerInput): Promise<ScannerOutput> {
    const transcriptPath = input.transcriptPath;
    if (!transcriptPath) {
      throw new Error('friction-log: claude-code adapter requires --transcript <path>');
    }
    if (!existsSync(transcriptPath)) {
      throw new Error(`friction-log: transcript not found at ${transcriptPath}`);
    }

    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as TranscriptEntry);
      } catch {
        continue;
      }
    }

    const sessionId = input.sessionId ?? deriveSessionIdFromPath(transcriptPath);
    const { startedAt, endedAt, cwds } = sessionBounds(entries);
    const candidates = extractCandidates(entries);

    return {
      session: {
        id: sessionId,
        startedAt,
        endedAt,
        projectPaths: cwds.length > 0 ? cwds : null,
        transcriptPath,
      },
      frictionCandidates: candidates,
    };
  }
}

function deriveSessionIdFromPath(transcriptPath: string): string {
  const base = transcriptPath.replace(/\\/g, '/').split('/').pop() ?? transcriptPath;
  return base.replace(/\.jsonl$/i, '');
}

function sessionBounds(entries: TranscriptEntry[]): {
  startedAt: string;
  endedAt: string | null;
  cwds: string[];
} {
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  const cwds = new Set<string>();
  for (const e of entries) {
    const ts = isMessageEntry(e) ? e.timestamp : undefined;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }
    if (isMessageEntry(e) && typeof e.cwd === 'string' && e.cwd.length > 0) {
      cwds.add(e.cwd);
    }
  }
  return {
    startedAt: startedAt ?? fileMtimeIso(),
    endedAt,
    cwds: [...cwds],
  };
}

function fileMtimeIso(): string {
  return new Date().toISOString();
}

function isMessageEntry(e: TranscriptEntry): e is MessageEntry {
  return e.type === 'user' || e.type === 'assistant';
}

function extractCandidates(entries: TranscriptEntry[]): RawFrictionCandidate[] {
  const toolUseById = new Map<string, string>();
  const out: RawFrictionCandidate[] = [];
  const seenTitles = new Set<string>();

  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue;
    const blocks = normalizeContent(entry.message?.content);

    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const tu = block as ToolUseBlock;
        toolUseById.set(tu.id, tu.name);
      } else if (block.type === 'tool_result') {
        const tr = block as ToolResultBlock;
        if (!tr.is_error) continue;
        const toolName = toolUseById.get(tr.tool_use_id) ?? 'unknown-tool';
        const errText = stringifyContent(tr.content);
        const candidate = toolErrorCandidate(toolName, errText);
        addUnique(out, seenTitles, candidate);
      } else if (block.type === 'text' && entry.type === 'assistant') {
        const text = (block as TextBlock).text ?? '';
        for (const c of phraseCandidates(text)) {
          addUnique(out, seenTitles, c);
        }
      }
    }
  }

  return out;
}

function addUnique(
  out: RawFrictionCandidate[],
  seen: Set<string>,
  candidate: RawFrictionCandidate
): void {
  const key = `${candidate.toolSurface ?? ''}|${candidate.title}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(candidate);
}

function normalizeContent(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text);
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function toolErrorCandidate(toolName: string, errText: string): RawFrictionCandidate {
  const firstLine = errText.split('\n')[0]?.trim() ?? '';
  const exitMatch = /^Exit code (\d+)/i.exec(firstLine);
  if (toolName === 'Bash' && exitMatch) {
    const code = exitMatch[1];
    return {
      toolSurface: 'bash',
      title: `Bash exited with code ${code}`,
      description: truncate(errText, 2000),
      severity: 'medium',
      category: 'tool-error',
    };
  }
  const summary = truncate(firstLine || errText, 120);
  return {
    toolSurface: toolName,
    title: `${toolName} returned an error: ${summary}`,
    description: truncate(errText, 2000),
    severity: 'medium',
    category: 'tool-error',
  };
}

function phraseCandidates(text: string): RawFrictionCandidate[] {
  const candidates: RawFrictionCandidate[] = [];
  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PHRASE_LINE_CHARS) continue;
    if (trimmed.endsWith('?')) continue;
    for (const pattern of FRICTION_PHRASE_PATTERNS) {
      const m = pattern.exec(trimmed);
      if (m) {
        candidates.push({
          toolSurface: null,
          title: `friction phrase: ${truncate(trimmed, 100)}`,
          description: trimmed,
          severity: 'low',
          category: 'workflow-friction',
        });
        break;
      }
    }
  }
  return candidates;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function fileExistsCheck(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

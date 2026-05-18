export type FrictionSource = 'scan' | 'manual' | 'import';

export type FrictionStatus = 'open' | 'filed' | 'resolved' | 'wontfix';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Session {
  id: string;
  startedAt: string;
  endedAt: string | null;
  projectPaths: string[] | null;
  transcriptPath: string | null;
  adapter: string;
}

export interface Friction {
  id: number;
  sessionId: string | null;
  toolSurface: string | null;
  title: string;
  description: string | null;
  capturedAt: string;
  severity: Severity | null;
  category: string | null;
  status: FrictionStatus;
  recurrenceOfId: number | null;
  source: FrictionSource;
}

export interface Task {
  id: number;
  frictionId: number;
  sinkName: string;
  sinkTarget: string | null;
  externalRef: string | null;
  createdAt: string;
  prUrl: string | null;
  resolutionStatus: string | null;
}

export interface Template {
  name: string;
  title: string;
  body: string;
  labels: string[];
  priority: Priority;
  metadata?: Record<string, unknown>;
}

export interface RenderedTemplate {
  title: string;
  body: string;
  labels: string[];
  priority: Priority;
  metadata?: Record<string, unknown>;
}

export interface FileOptions {
  // Legacy shortcut used by markdown-file's CLI flag. Equivalent to
  // sinkOpts.target for that sink, kept on FileOptions so the old call shape
  // (`{ sinkTarget }`) keeps compiling.
  sinkTarget?: string;
  // Sink-specific configuration. The `file` command merges the config-file
  // section for the sink with any --sink-opt CLI overrides and passes the
  // result here. Each sink validates the keys it cares about; unknown keys
  // are passed through untouched so a forward-compatible CLI doesn't fail
  // against an older sink build.
  sinkOpts?: Record<string, unknown>;
}

export interface FileResult {
  ok: boolean;
  sinkTarget: string;
  externalRef?: string;
  prUrl?: string;
  message?: string;
}

export interface Sink {
  readonly name: string;
  file(friction: Friction, rendered: RenderedTemplate, opts: FileOptions): Promise<FileResult>;
}

export interface ScannerInput {
  sessionId?: string;
  transcriptPath?: string;
}

export interface ScannerOutput {
  session: Omit<Session, 'adapter'> & { adapter?: string };
  frictionCandidates: Array<Pick<Friction, 'toolSurface' | 'title' | 'description' | 'severity' | 'category'>>;
}

export interface Scanner {
  readonly name: string;
  scan(input: ScannerInput): Promise<ScannerOutput>;
}

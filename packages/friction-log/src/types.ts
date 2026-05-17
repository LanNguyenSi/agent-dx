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
  sinkTarget?: string;
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

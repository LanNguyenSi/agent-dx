import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface Component {
  name: string;
  role: string;
}

export interface AgentEntrypoint {
  project: string;
  primary_docs: string[];
  components: Component[];
  first_checks: string[];
  do_not_assume: string[];
  authoritative_sources: string[];
}

export const FILENAME = 'AGENT_ENTRYPOINT.yaml';

export function detectDocs(dir: string): string[] {
  const candidates = ['README.md', 'ARCHITECTURE.md', 'docs/architecture.md', 'CONTRIBUTING.md', 'AGENTS.md'];
  return candidates.filter(f => fs.existsSync(path.join(dir, f)));
}

export function detectComponents(dir: string): Component[] {
  const components: Component[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const name = entry.name;
    let role = 'module';
    if (name.includes('api') || name.includes('server')) role = 'api server';
    else if (name.includes('web') || name.includes('ui') || name.includes('frontend') || name.includes('app')) role = 'frontend';
    else if (name.includes('agent')) role = 'agent';
    else if (name.includes('cli')) role = 'cli tool';
    else if (name.includes('lib') || name.includes('core') || name.includes('shared')) role = 'shared library';
    components.push({ name, role });
  }
  return components.slice(0, 6);
}

export function detectStartCommands(dir: string): string[] {
  const checks: string[] = [];
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    checks.push('npm install && npm run build');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    if (pkg.scripts?.dev) checks.push('npm run dev');
    if (pkg.scripts?.start) checks.push('npm start');
  }
  if (fs.existsSync(path.join(dir, 'Makefile'))) checks.push('make');
  if (fs.existsSync(path.join(dir, 'docker-compose.yml')) || fs.existsSync(path.join(dir, 'docker-compose.yaml')))
    checks.push('docker compose up');
  if (checks.length === 0) checks.push('check README.md for start instructions');
  return checks;
}

export function generateManifest(dir: string, projectName?: string): AgentEntrypoint {
  const name = projectName || path.basename(dir);
  const docs = detectDocs(dir);
  const components = detectComponents(dir);
  const startChecks = detectStartCommands(dir);

  return {
    project: name,
    primary_docs: docs.length > 0 ? docs : ['README.md'],
    components: components.length > 0 ? components : [{ name, role: 'main module' }],
    first_checks: [
      ...startChecks,
      'verify all required env vars are set',
      'check logs for startup errors',
    ],
    do_not_assume: [
      'environment matches local dev',
      'default config is correct',
      'dependencies are already installed',
    ],
    authoritative_sources: docs.length > 0 ? docs.slice(0, 2) : ['README.md'],
  };
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  manifest?: AgentEntrypoint;
}

export function validateManifest(dir: string): ValidationResult {
  const filePath = path.join(dir, FILENAME);
  const issues: string[] = [];

  if (!fs.existsSync(filePath)) {
    return { valid: false, issues: [`${FILENAME} not found`] };
  }

  let manifest: Partial<AgentEntrypoint>;
  try {
    manifest = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Partial<AgentEntrypoint>;
  } catch (e) {
    return { valid: false, issues: [`YAML parse error: ${e}`] };
  }

  const required: Array<keyof AgentEntrypoint> = [
    'project', 'primary_docs', 'components', 'first_checks', 'do_not_assume', 'authoritative_sources'
  ];
  for (const field of required) {
    if (!manifest[field]) issues.push(`Missing field: ${field}`);
  }

  for (const doc of manifest.primary_docs || []) {
    if (!fs.existsSync(path.join(dir, doc))) {
      issues.push(`primary_docs: '${doc}' does not exist`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    manifest: issues.length === 0 ? manifest as AgentEntrypoint : undefined,
  };
}

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { SinkName } from '../sinks/index.js';
import { defaultConfigPath } from '../paths.js';

export type InitDefaultSink = SinkName;

export interface InitDetected {
  claudeCodeSettingsPath: string | null;
  ghAvailable: boolean;
  linearKeyPresent: boolean;
  agentTasksTokenPresent: boolean;
}

export interface InitCommandInput {
  configPath?: string;
  sink?: InitDefaultSink;
  yes?: boolean;
  installStopHook?: boolean;
  prompt?: Prompter;
  detect?: () => InitDetected;
}

export interface InitCommandOutput {
  configPath: string;
  configWritten: boolean;
  configExistedBefore: boolean;
  defaultSink: InitDefaultSink;
  stopHookWrittenTo: string | null;
  detected: InitDetected;
  nextSteps: string[];
}

export interface Prompter {
  select(question: string, choices: readonly string[], def?: string): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
}

export async function runInit(input: InitCommandInput = {}): Promise<InitCommandOutput> {
  const configPath = input.configPath ?? defaultConfigPath();
  const detected = (input.detect ?? defaultDetect)();
  const interactive = input.yes !== true;
  const prompt = input.prompt ?? readlinePrompter();

  const defaultSink = input.sink
    ?? (interactive
      ? ((await prompt.select(
          'Default sink',
          ['markdown-file', 'stdout-json', 'github-issues', 'agent-tasks', 'linear'],
          suggestSink(detected)
        )) as InitDefaultSink)
      : suggestSink(detected));

  const configExistedBefore = existsSync(configPath);
  const existing = configExistedBefore ? readFileSync(configPath, 'utf8') : '';
  const newConfig = mergeConfigYaml(existing, defaultSink);

  // Only write when the content actually changes; idempotency matters when
  // init is run multiple times during onboarding.
  let configWritten = false;
  if (newConfig !== existing) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, newConfig, 'utf8');
    configWritten = true;
  }

  let stopHookWrittenTo: string | null = null;
  const wantHook = input.installStopHook
    ?? (detected.claudeCodeSettingsPath !== null
      && (interactive
        ? await prompt.confirm('Install friction-log scan as a Claude Code Stop-hook?', true)
        : false));

  if (wantHook && detected.claudeCodeSettingsPath) {
    const path = detected.claudeCodeSettingsPath;
    const before = existsSync(path) ? readFileSync(path, 'utf8') : '{}';
    const after = mergeStopHook(before);
    if (after !== before) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, after, 'utf8');
    }
    stopHookWrittenTo = path;
  }

  return {
    configPath,
    configWritten,
    configExistedBefore,
    defaultSink,
    stopHookWrittenTo,
    detected,
    nextSteps: buildNextSteps(defaultSink, configPath, stopHookWrittenTo),
  };
}

function suggestSink(d: InitDetected): InitDefaultSink {
  if (d.agentTasksTokenPresent) return 'agent-tasks';
  if (d.linearKeyPresent) return 'linear';
  if (d.ghAvailable) return 'github-issues';
  return 'markdown-file';
}

function defaultDetect(): InitDetected {
  const claudeHome = process.env.CLAUDE_HOME ?? join(homedir(), '.claude');
  const settingsPath = join(claudeHome, 'settings.json');
  const claudeCodeSettingsPath = existsSync(claudeHome) ? settingsPath : null;
  const which = spawnSync('which', ['gh'], { encoding: 'utf8' });
  const ghAvailable = which.status === 0 && Boolean((which.stdout ?? '').trim());
  return {
    claudeCodeSettingsPath,
    ghAvailable,
    linearKeyPresent: Boolean(process.env.LINEAR_API_KEY),
    agentTasksTokenPresent: Boolean(process.env.AGENT_TASKS_TOKEN),
  };
}

export function mergeConfigYaml(existingYaml: string, defaultSink: InitDefaultSink): string {
  // Parse as best-effort; if existing config is corrupt we still want init
  // to land a clean default scaffolding rather than wedging the user.
  let parsed: Record<string, unknown> = {};
  if (existingYaml.trim()) {
    try {
      const tmp = parseYaml(existingYaml) as unknown;
      if (tmp && typeof tmp === 'object' && !Array.isArray(tmp)) {
        parsed = tmp as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  const sinks = (parsed.sinks && typeof parsed.sinks === 'object' && !Array.isArray(parsed.sinks))
    ? (parsed.sinks as Record<string, unknown>)
    : {};
  if (!sinks[defaultSink]) {
    sinks[defaultSink] = scaffoldForSink(defaultSink);
  }
  parsed.sinks = sinks;
  parsed.default_sink = defaultSink;
  return stringifyYaml(parsed);
}

function scaffoldForSink(sink: InitDefaultSink): Record<string, unknown> {
  switch (sink) {
    case 'markdown-file':
      return {};
    case 'stdout-json':
      return {};
    case 'github-issues':
      return { repo: 'owner/repo', labels: ['friction'] };
    case 'agent-tasks':
      return { mode: 'rest', apiBase: 'https://agent-tasks.example.test', projectId: '<uuid>' };
    case 'linear':
      return { teamId: '<team-uuid>', state: 'Backlog' };
  }
}

const STOP_HOOK = {
  type: 'command',
  command: 'friction-log scan --silent --stdin-payload',
};

export function mergeStopHook(existingJson: string): string {
  let parsed: Record<string, unknown> = {};
  if (existingJson.trim()) {
    try {
      const tmp = JSON.parse(existingJson) as unknown;
      if (tmp && typeof tmp === 'object' && !Array.isArray(tmp)) {
        parsed = tmp as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  const hooks = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
    ? (parsed.hooks as Record<string, unknown>)
    : {};
  const stopEntries = Array.isArray(hooks.Stop) ? (hooks.Stop as Array<Record<string, unknown>>) : [];
  let group = stopEntries.find((e) => e && typeof e === 'object' && (!('matcher' in e) || e.matcher === ''));
  if (!group) {
    group = { matcher: '', hooks: [] };
    stopEntries.push(group);
  }
  const groupHooks = Array.isArray(group.hooks) ? (group.hooks as Array<Record<string, unknown>>) : [];
  if (!groupHooks.some((h) => h?.command === STOP_HOOK.command)) {
    groupHooks.push({ ...STOP_HOOK });
  }
  group.hooks = groupHooks;
  hooks.Stop = stopEntries;
  parsed.hooks = hooks;
  return JSON.stringify(parsed, null, 2) + '\n';
}

function buildNextSteps(sink: InitDefaultSink, configPath: string, stopHook: string | null): string[] {
  const out: string[] = [];
  out.push(`Configuration written to ${configPath}.`);
  out.push(`Default sink: ${sink}.`);
  if (stopHook) {
    out.push(`Stop-hook installed at ${stopHook}; new sessions auto-scan on close.`);
  } else {
    out.push(`Stop-hook not installed. Run "friction-log scan" manually at end of session, or re-run "init" later.`);
  }
  out.push('Quick smoke:');
  out.push(`  friction-log log --title "first friction" --tool "demo" --category tool-error`);
  out.push(`  friction-log list`);
  out.push(`  friction-log file 1 --sink ${sink}`);
  return out;
}

/** Minimal readline-based prompter so init has no new runtime dep. */
function readlinePrompter(): Prompter {
  return {
    async select(question, choices, def) {
      const rl = await loadReadline();
      try {
        const list = choices.map((c, i) => `  ${i + 1}) ${c}${c === def ? ' (default)' : ''}`).join('\n');
        const prompt = `${question}\n${list}\nChoice [${def ?? choices[0]}]: `;
        const raw = (await rl.question(prompt)).trim();
        if (!raw) return def ?? choices[0];
        const asIdx = Number(raw);
        if (Number.isInteger(asIdx) && asIdx >= 1 && asIdx <= choices.length) {
          return choices[asIdx - 1];
        }
        if (choices.includes(raw)) return raw;
        process.stderr.write(`(invalid choice "${raw}"; using ${def ?? choices[0]})\n`);
        return def ?? choices[0];
      } finally {
        rl.close();
      }
    },
    async confirm(question, def = true) {
      const rl = await loadReadline();
      try {
        const hint = def ? 'Y/n' : 'y/N';
        const raw = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
        if (!raw) return def;
        if (raw === 'y' || raw === 'yes') return true;
        if (raw === 'n' || raw === 'no') return false;
        return def;
      } finally {
        rl.close();
      }
    },
  };
}

async function loadReadline(): Promise<{ question: (q: string) => Promise<string>; close: () => void }> {
  const readline = await import('node:readline/promises');
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}


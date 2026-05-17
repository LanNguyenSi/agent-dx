import type { Scanner } from '../types.js';
import { ClaudeCodeAdapter } from './claude-code.js';

export type ScannerName = 'claude-code';

export function loadScanner(name: string): Scanner {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    default:
      throw new Error(
        `friction-log: unknown scanner "${name}". Available in M2: claude-code. ` +
          `Other adapters (cursor, aider, opencode) are planned for later milestones.`
      );
  }
}

export const availableScanners: readonly string[] = ['claude-code'];

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_TOKEN = process.env.GITHUB_TOKEN;

async function loadConfigModuleFresh() {
  vi.resetModules();
  return (await import('../utils/config.js')) as typeof import('../utils/config.js');
}

describe('config', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'github-api-tool-config-'));
    process.env.HOME = tempHome;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
    process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it('prefers GITHUB_TOKEN over the config file', async () => {
    process.env.GITHUB_TOKEN = 'env-token';

    const { loadConfig, saveConfig } = await loadConfigModuleFresh();
    await saveConfig({ token: 'file-token' });
    const config = await loadConfig();

    expect(config.token).toBe('env-token');
  });

  it('falls back to the config file when GITHUB_TOKEN is not set', async () => {
    const { loadConfig, saveConfig } = await loadConfigModuleFresh();
    await saveConfig({
      token: 'file-token',
      defaultOwner: 'lan',
      defaultRepo: 'agent-dx',
    });

    const config = await loadConfig();

    expect(config).toEqual({
      token: 'file-token',
      defaultOwner: 'lan',
      defaultRepo: 'agent-dx',
    });
  });

  it('throws a helpful error when no token is configured anywhere', async () => {
    const { loadConfig } = await loadConfigModuleFresh();

    await expect(loadConfig()).rejects.toThrow(/No GitHub token found/);
  });

  it('getToken() returns the resolved token', async () => {
    process.env.GITHUB_TOKEN = 'resolved-token';

    const { getToken } = await loadConfigModuleFresh();
    const token = await getToken();

    expect(token).toBe('resolved-token');
  });

  it('saveConfig() persists JSON to ~/.github-api-tool/config.json', async () => {
    const { saveConfig } = await loadConfigModuleFresh();
    await saveConfig({ token: 'persisted-token', defaultOwner: 'lan' });

    const written = await readFile(
      join(tempHome, '.github-api-tool', 'config.json'),
      'utf-8',
    );
    expect(JSON.parse(written)).toEqual({
      token: 'persisted-token',
      defaultOwner: 'lan',
    });
  });
});

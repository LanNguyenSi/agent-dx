import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadConfigModuleFresh() {
  vi.resetModules();
  return (await import('../utils/config.js')) as typeof import('../utils/config.js');
}

describe('config', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalToken: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalToken = process.env.GITHUB_TOKEN;

    tempHome = await mkdtemp(join(tmpdir(), 'github-api-tool-config-'));
    process.env.HOME = tempHome;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
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

  it('re-hardens a pre-existing CONFIG_DIR with loose perms to 0o700', async () => {
    // Simulate a directory created before the perms fix: world-readable.
    const configDir = join(tempHome, '.github-api-tool');
    await mkdir(configDir, { recursive: true });
    await chmod(configDir, 0o755);

    const { saveConfig } = await loadConfigModuleFresh();
    await saveConfig({ token: 'persisted-token' });

    const mode = (await stat(configDir)).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../index';

function makeProgram(
  handlers: Parameters<typeof buildProgram>[0] = {},
): ReturnType<typeof buildProgram> {
  const program = buildProgram(handlers);
  program.exitOverride();
  return program;
}

describe('agent-entrypoint CLI parser', () => {
  it('routes `generate` to the generate handler with parsed options', async () => {
    const generate = vi.fn();
    const program = makeProgram({ generate });

    await program.parseAsync(['node', 'agent-entrypoint', 'generate', '--dir', '/tmp/repo']);

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ dir: '/tmp/repo' });
  });

  it('accepts the `gen` alias for generate and the --project flag', async () => {
    const generate = vi.fn();
    const program = makeProgram({ generate });

    await program.parseAsync([
      'node',
      'agent-entrypoint',
      'gen',
      '-d',
      '/tmp/repo',
      '-p',
      'my-project',
      '--force',
    ]);

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      dir: '/tmp/repo',
      project: 'my-project',
      force: true,
    });
  });

  it('defaults --dir to "." for generate when not passed', async () => {
    const generate = vi.fn();
    const program = makeProgram({ generate });

    await program.parseAsync(['node', 'agent-entrypoint', 'generate']);

    expect(generate.mock.calls[0]?.[0]).toMatchObject({ dir: '.' });
  });

  it('routes `validate` to the validate handler with parsed options', async () => {
    const validate = vi.fn();
    const program = makeProgram({ validate });

    await program.parseAsync(['node', 'agent-entrypoint', 'validate', '-d', '/tmp/repo']);

    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.calls[0]?.[0]).toMatchObject({ dir: '/tmp/repo' });
  });

  it('accepts the `check` alias for validate', async () => {
    const validate = vi.fn();
    const program = makeProgram({ validate });

    await program.parseAsync(['node', 'agent-entrypoint', 'check']);

    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.calls[0]?.[0]).toMatchObject({ dir: '.' });
  });

  it('routes `show` to the show handler', async () => {
    const show = vi.fn();
    const program = makeProgram({ show });

    await program.parseAsync(['node', 'agent-entrypoint', 'show', '-d', '/tmp/repo']);

    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]?.[0]).toMatchObject({ dir: '/tmp/repo' });
  });

  it('rejects an unknown subcommand', async () => {
    const program = makeProgram();

    await expect(
      program.parseAsync(['node', 'agent-entrypoint', 'not-a-command']),
    ).rejects.toThrow();
  });

  it('does not invoke unrelated handlers when one subcommand runs', async () => {
    const generate = vi.fn();
    const validate = vi.fn();
    const show = vi.fn();
    const program = makeProgram({ generate, validate, show });

    await program.parseAsync(['node', 'agent-entrypoint', 'show']);

    expect(show).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });
});

import { FrictionDb } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { loadSink } from '../sinks/index.js';
import { loadTemplate, pickTemplateForCategory, render } from '../templates.js';

export interface FileCommandInput {
  frictionId: number;
  sink?: string;
  template?: string;
  sinkTarget?: string;
  dbPath?: string;
}

export interface FileCommandOutput {
  taskId: number;
  sinkName: string;
  sinkTarget: string;
  externalRef?: string;
  message: string;
}

export async function runFile(input: FileCommandInput): Promise<FileCommandOutput> {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const friction = db.getFriction(input.frictionId);
    if (!friction) {
      throw new Error(`friction-log: friction id=${input.frictionId} not found`);
    }
    const sinkName = input.sink ?? 'markdown-file';
    const sink = loadSink(sinkName);
    const templateName = input.template ?? pickTemplateForCategory(friction.category);
    const template = loadTemplate(templateName);
    const rendered = render(template, friction);
    const result = await sink.file(friction, rendered, { sinkTarget: input.sinkTarget });
    if (!result.ok) {
      throw new Error(`friction-log: sink "${sinkName}" failed: ${result.message ?? 'unknown error'}`);
    }
    const task = db.insertTask({
      frictionId: friction.id,
      sinkName,
      sinkTarget: result.sinkTarget,
      externalRef: result.externalRef ?? null,
      prUrl: result.prUrl ?? null,
    });
    db.updateFrictionStatus(friction.id, 'filed');
    return {
      taskId: task.id,
      sinkName,
      sinkTarget: result.sinkTarget,
      externalRef: result.externalRef,
      message: result.message ?? 'filed',
    };
  } finally {
    db.close();
  }
}

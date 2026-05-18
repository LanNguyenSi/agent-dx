import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'probe-'));
const path = join(dir, 'db.sqlite');
const raw = new Database(path);
raw.pragma('foreign_keys = ON');
raw.exec(`
  CREATE TABLE frictions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
  CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, friction_id INTEGER NOT NULL REFERENCES frictions(id), n TEXT);
  INSERT INTO frictions (title) VALUES ('a');
  INSERT INTO tasks (friction_id, n) VALUES (1, 'x');
`);
try {
  raw.exec(`
    CREATE TABLE frictions_new (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
    INSERT INTO frictions_new SELECT * FROM frictions;
    DROP TABLE frictions;
    ALTER TABLE frictions_new RENAME TO frictions;
  `);
  console.log('table-swap OK with foreign_keys=ON');
} catch (e) {
  console.log('table-swap FAILED with foreign_keys=ON:', e.message);
  // Try defer pattern: turn off FK before, run, turn on after
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    CREATE TABLE frictions_new (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
    INSERT INTO frictions_new SELECT * FROM frictions;
    DROP TABLE frictions;
    ALTER TABLE frictions_new RENAME TO frictions;
  `);
  raw.pragma('foreign_keys = ON');
  console.log('defer pattern OK');
  console.log('tasks rows after:', raw.prepare(`SELECT * FROM tasks`).all());
  console.log('fk list tasks:', raw.pragma('foreign_key_list(tasks)'));
  console.log('foreign_key_check:', raw.pragma('foreign_key_check'));
}
raw.close();

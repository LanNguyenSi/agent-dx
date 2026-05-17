import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'templates');
const dst = resolve(here, '..', 'dist', 'templates');

if (!existsSync(src)) {
  console.error(`copy-templates: source missing at ${src}`);
  process.exit(1);
}
mkdirSync(dirname(dst), { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`copy-templates: ${src} -> ${dst}`);

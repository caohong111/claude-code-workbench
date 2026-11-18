import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp');
mkdirSync(TEST_ROOT, { recursive: true });

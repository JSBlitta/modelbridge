import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadFixture(name: string): unknown {
  const path = resolve(process.cwd(), 'responses', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

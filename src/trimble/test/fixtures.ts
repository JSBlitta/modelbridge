import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), 'responses');

// Captured real API responses. They are not shipped with a release, so the
// fixture tests skip instead of failing setup.bat on a machine without them.
export const hasFixtures = existsSync(dir);

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(dir, name), 'utf-8'));
}

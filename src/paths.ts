import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let root: string | undefined;

/** Directory that holds package.json, whether running from `src/` (tsx, vitest) or `dist/` (built). */
export function packageRoot(): string {
  if (root) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'registry'))) {
      root = dir;
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error('Could not locate the holdon package root (package.json + registry/).');
}

export function packagePath(...segments: string[]): string {
  return join(packageRoot(), ...segments);
}

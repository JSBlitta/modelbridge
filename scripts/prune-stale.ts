// Releases arrive as a 7z unpacked over the existing folder. Unpacking adds and
// overwrites but never deletes, so a file dropped from the code stays behind,
// and because tsconfig typechecks all of src/**, one orphan fails setup.bat.
//
// release-manifest.txt (written by scripts/pack-release.ts) lists every file in
// the release. Anything in the code folders below that is NOT listed is moved
// to _attic/stale/<timestamp>/, never deleted, so nothing local is lost.
// .env, state.db, data/ and everything else outside these folders is untouched.
//
// Run: tsx scripts/prune-stale.ts   (setup.bat does this after npm install)

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const MANIFEST = join(ROOT, "release-manifest.txt");
const CODE_DIRS = ["src", "frontend/src", "scripts"];

export function staleFiles(root: string, listed: Set<string>, dirs = CODE_DIRS): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split(sep).join("/");
        if (!listed.has(rel)) out.push(rel);
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

function main(): void {
  if (!existsSync(MANIFEST)) {
    console.log("     No release-manifest.txt (not an unpacked release); nothing pruned.");
    return;
  }
  const listed = new Set(
    readFileSync(MANIFEST, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  );
  const stale = staleFiles(ROOT, listed);
  if (!stale.length) {
    console.log("     No leftover files from earlier releases.");
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dest = join(ROOT, "_attic", "stale", stamp);
  for (const rel of stale) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(ROOT, rel), target);
    console.log(`     moved ${rel} -> _attic/stale/${stamp}/${rel}`);
  }
  console.log(`     ${stale.length} file(s) not in this release moved out of the build.`);
}

if (process.argv[1] && process.argv[1].endsWith("prune-stale.ts")) main();

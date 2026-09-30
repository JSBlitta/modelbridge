// Build the release 7z for the target machine: every file git tracks, plus
// release-manifest.txt listing them, so setup.bat can move out whatever an
// earlier release left behind (see scripts/prune-stale.ts).
//
// Run from the repo root: bun scripts/pack-release.ts [out.7z]
// Needs 7z on PATH. Packs HEAD's tracked files as they are on disk.

import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const out = process.argv[2] ?? `modelbridge-${commit}.7z`;
const files = execFileSync("git", ["ls-files"]).toString().split("\n").filter(Boolean);
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"]).toString().trim();
if (dirty) {
  console.error("Uncommitted changes; commit first so the archive matches a commit:\n" + dirty);
  process.exit(1);
}

writeFileSync("release-manifest.txt", [...files, "release-manifest.txt"].join("\n") + "\n");
writeFileSync(".release-filelist", [...files, "release-manifest.txt"].join("\n") + "\n");
rmSync(out, { force: true });
try {
  execFileSync("7z", ["a", "-t7z", "-mx=9", out, "@.release-filelist"], { stdio: "ignore" });
} finally {
  rmSync(".release-filelist", { force: true });
  rmSync("release-manifest.txt", { force: true });
}
console.log(`${out}: ${files.length + 1} files from ${commit}`);

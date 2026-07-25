// Build-time manifest for the migration drift checker (prompt 48).
//
// Netlify functions do not get the repo working tree at runtime, so the
// deployed pec-migration-drift.cjs cannot fs.readdir supabase/migrations/.
// This script parses every migration's @artifacts header (CLAUDE.md rule 13)
// into netlify/functions/_migration-manifest.json at BUILD time; netlify.toml
// runs it as the first step of the build command, and the generated file is
// also committed so a local `node netlify/functions/...` run works without a
// build. Output is deterministic (no timestamps) so the committed file only
// changes when a migration file does.
//
// Run manually: node scripts/build-migration-manifest.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migDir = path.join(root, 'supabase', 'migrations');
const outFile = path.join(root, 'netlify', 'functions', '_migration-manifest.json');

const ARTIFACT_RE = /^--\s+(table|column|index|setting):\s+(\S+)\s*$/;
const NONE_RE = /^--\s+none:\s+(.+?)\s*$/;

// Parse the @artifacts header block. Returns:
//   { artifacts: [{kind,name}], none: string|null, hasHeader: boolean }
function parseHeader(sql) {
  const lines = sql.split('\n');
  const start = lines.findIndex((l) => l.trim() === '-- @artifacts');
  if (start === -1) return { artifacts: [], none: null, hasHeader: false };
  const artifacts = [];
  let none = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '-- @end') break;
    const a = line.match(ARTIFACT_RE);
    if (a) { artifacts.push({ kind: a[1], name: a[2] }); continue; }
    const n = line.match(NONE_RE);
    if (n) none = n[1];
  }
  return { artifacts, none, hasHeader: true };
}

// Every `create table` across ALL SQL in supabase/ (base schema + every
// migration, headered or not). This is the reverse-drift allowlist: a prod
// table is only "reverse drift" if NO file in the repo creates it, so
// pre-baseline tables never false-positive without hand-maintaining a list.
function scanCreatedTables() {
  const tables = new Set();
  const sqlFiles = [];
  for (const f of readdirSync(path.join(root, 'supabase'))) {
    if (f.endsWith('.sql')) sqlFiles.push(path.join(root, 'supabase', f));
  }
  for (const f of readdirSync(migDir)) {
    if (f.endsWith('.sql')) sqlFiles.push(path.join(migDir, f));
  }
  for (const file of sqlFiles) {
    const sql = readFileSync(file, 'utf8').replace(/--[^\n]*/g, ' ');
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      tables.add(m[1]);
    }
  }
  return [...tables].sort();
}

const migrations = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => {
    const { artifacts, none, hasHeader } = parseHeader(readFileSync(path.join(migDir, file), 'utf8'));
    const date = (file.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    return { file, date, hasHeader, none, artifacts };
  });

const manifest = { migrations, knownTables: scanCreatedTables() };
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');

const withHeader = migrations.filter((m) => m.hasHeader).length;
const artifactCount = migrations.reduce((n, m) => n + m.artifacts.length, 0);
console.log(`migration manifest: ${migrations.length} files (${withHeader} with @artifacts, ${artifactCount} artifacts, ${manifest.knownTables.length} known tables) -> ${path.relative(root, outFile)}`);

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let failures = 0;
for (const file of readdirSync('netlify/functions').filter(x => x.endsWith('.cjs'))) {
  const result = spawnSync(process.execPath, ['--check', `netlify/functions/${file}`], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); failures++; }
}
for (const file of ['features.json', 'help/whats-new.json', 'scripts/public-assets.json']) JSON.parse(readFileSync(file, 'utf8'));
const html = readFileSync('index.html', 'utf8');
let scripts = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const [, attrs, source] = match;
  if (!source.trim() || /\bsrc\s*=/.test(attrs) || /type\s*=\s*["'](?:application\/ld\+json|application\/json)["']/.test(attrs)) continue;
  scripts++;
  const mode = /type\s*=\s*["']module["']/.test(attrs) ? 'module' : 'commonjs';
  const result = spawnSync(process.execPath, ['--check', `--input-type=${mode}`], { input: source, encoding: 'utf8' });
  if (result.status !== 0) { console.error(`Dashboard script ${scripts}: ${result.stderr}`); failures++; }
}
if (failures) process.exit(1);
console.log(`Server source, JSON and ${scripts} dashboard scripts parse successfully.`);

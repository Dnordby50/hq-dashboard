#!/usr/bin/env node
// Read-only context routing. No credentials, network, source dumps, or writes.
import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let feature = '', maxChars = 12000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--feature' && args[i + 1] !== undefined) feature = args[++i].trim();
  else if (args[i] === '--max-chars' && /^\d+$/.test(args[i + 1] || '')) maxChars = Number(args[++i]);
  else if (args[i] === '--help') {
    console.log('Usage: node scripts/context-packet.mjs [--feature "name"] [--max-chars 4000..20000]');
    process.exit(0);
  } else {
    console.error(`Unknown or incomplete option: ${args[i]}`);
    process.exit(2);
  }
}
if (maxChars < 4000 || maxChars > 20000 || feature.length > 200) {
  console.error('Use --max-chars 4000..20000 and a feature query of at most 200 characters.');
  process.exit(2);
}

const clip = (text, max) => text.length <= max ? text : text.slice(0, max - 22) + ' [truncated; inspect]';
const git = (...argv) => {
  try { return execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 }).trim(); }
  catch { return '(git information unavailable)'; }
};
function prefix(path, bytes = 65536) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const count = readSync(fd, buffer, 0, bytes, 0);
    return { text: buffer.subarray(0, count).toString('utf8'), capped: count === bytes };
  } finally { closeSync(fd); }
}

const sections = [];
const add = (title, text) => sections.push(`## ${title}\n${text}`);
add('Current checkout', `Repository: ${root}\nCommit: ${git('log', '-1', '--format=%H %s')}\n${clip(git('status', '-sb'), 1800)}`);
const gitDir = resolve(root, git('rev-parse', '--git-dir'));
const locks = existsSync(gitDir) ? readdirSync(gitDir).filter(name => name.endsWith('.lock')) : [];
add('Coordination', `Git locks: ${locks.length ? locks.join(', ') : 'none'}\nPreserve changes owned by another task. A lock is not proof that its owner is stale.`);

const logPath = join(root, 'PROJECT-LOG.md');
if (existsSync(logPath)) {
  const log = prefix(logPath);
  const headers = [...log.text.matchAll(/^## \[\d{4}-\d{2}-\d{2}[^\n]*/gm)];
  const entries = [];
  for (let i = 0; i < Math.min(3, headers.length); i++) {
    const end = headers[i + 1]?.index ?? log.text.length;
    const text = log.text.slice(headers[i].index, end);
    const fields = text.split('\n').filter(line => /^(By:|Changed:|Verified:|Next steps:|Handoff to (Cowork|Dylan):)/.test(line));
    const line = log.text.slice(0, headers[i].index).split('\n').length;
    entries.push(`${headers[i][0].replace(/^## /, '')}\nSource: PROJECT-LOG.md:${line}\n${fields.map(field => clip(field, 300)).join('\n')}`);
  }
  add('Three recent changes (summaries, not an open-work queue)', entries.join('\n\n') || '(No dated entries found in the bounded log prefix.)');
  if (headers.length < 4 && log.capped) add('Log boundary', 'Only the first 64 KiB was inspected. A long entry may be incomplete; read the needed entry by its line anchor.');
}

if (feature) {
  const manifest = JSON.parse(readFileSync(join(root, 'features.json'), 'utf8'));
  const query = feature.toLowerCase();
  const ranked = (manifest.features || []).map(item => {
    const name = String(item.name || '').toLowerCase();
    const score = name === query ? 100 : name.includes(query) ? 50 : query.split(/\s+/).every(word => name.includes(word)) ? 20 : 0;
    return { item, score };
  }).filter(entry => entry.score).sort((a, b) => b.score - a.score);
  if (!ranked.length) add('Feature routing', `No feature name matched ${JSON.stringify(feature)}. Search manifest names before searching dashboard source.`);
  for (const { item } of ranked.slice(0, 2)) {
    const functions = (item.code?.netlifyFunctions || []).map(path => `netlify/functions/${path}`);
    const other = item.code?.other || [];
    const paths = [...functions, ...other];
    const missing = paths.filter(path => !existsSync(join(root, path)));
    add(`Feature: ${item.name}`, [
      `Area: ${item.area || 'unspecified'}`,
      `Dashboard anchors: ${(item.code?.indexHtml || []).slice(0, 15).join(', ') || '(none)'}`,
      `Files: ${paths.slice(0, 20).join(', ') || '(none)'}`,
      `Tables: ${(item.tables || []).join(', ') || '(none)'}; consult matching SCHEMA.md sections before queries.`,
      `Settings: ${(item.settings || []).slice(0, 20).join(', ') || '(none listed)'}`,
      ...(missing.length ? [`Missing manifest paths: ${missing.join(', ')} (verify before using)`] : []),
      `Description: ${clip(String(item.description || ''), 1500)}`,
    ].join('\n'));
  }
  if (ranked.length > 2) add('Feature boundary', `${ranked.length} names matched; only the two closest are shown. Use a more specific feature name.`);
} else add('Feature routing', 'Use --feature "feature name" to include up to two matching manifest entries.');

add('Required references', 'AGENTS.md + docs/product-charter.md once per task. Load docs/engineering-workflow.md only for relevant invariants. Historical CODEX handover is on-demand. This packet does not verify live deployment or schema.');
// Preserve the requested route even under a deliberately small ceiling;
// unrelated recent release prose follows the feature's anchors.
const priority = (section) => /^## Current checkout|^## Coordination/.test(section) ? 0 : /^## Feature[: ]/.test(section) ? 1 : 2;
sections.sort((a, b) => priority(a) - priority(b));
const text = '# TopCoat scoped task context\n\n' + sections.join('\n\n') + '\n';
const ending = '\n[Output ceiling reached; refine --feature or inspect the cited section. No omitted content should be assumed reviewed.]\n';
process.stdout.write(text.length <= maxChars ? text : text.slice(0, maxChars - ending.length) + ending);

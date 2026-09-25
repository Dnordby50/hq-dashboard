import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { allowedPublicPath, buildPublicSite } from '../scripts/build-public-site.mjs';
const manifest = JSON.parse(await readFile(new URL('../scripts/public-assets.json', import.meta.url), 'utf8'));

test('internal documents, backend code, maps and environment files cannot be published', () => {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'SCHEMA.md', 'features.json', '.env', 'netlify/functions/mcp.cjs', 'supabase/schema.sql', 'estimator/assets/source.js.map', 'estimator/notes.md', 'estimator/assets/../../.env']) assert.equal(allowedPublicPath(name), false, name);
  for (const name of ['index.html', 'help/whats-new.json', 'production/owner-studio.js', 'production/owner-mbp-workbook.js', 'production/owner-mbp-workbook-layout.js', 'estimator/sw.js', 'estimator/assets/index-A1b2.js']) assert.equal(allowedPublicPath(name), true, name);
});

// The generated workbook layout is published, so it must carry presentation only.
test('the published workbook layout contains no owner numbers, account names or workbook bytes', async () => {
  const source = await readFile(new URL('../production/owner-mbp-workbook-layout.js', import.meta.url), 'utf8');
  assert.ok(!/\$\s?\d/.test(source), 'no currency amounts');
  assert.ok(!/\.xlsx|Finishing Touch|Prescott Epoxy|Dylan/i.test(source), 'no workbook file name or private names');
  const { MBP_WORKBOOK_LAYOUT } = await import('../production/owner-mbp-workbook-layout.js');
  for (const [id, sheet] of Object.entries(MBP_WORKBOOK_LAYOUT.sheets)) {
    if (id === 'budget' || id === 'income') assert.deepEqual(sheet.labels, {}, `${id} account names stay in the private document`);
    for (const label of Object.values(sheet.labels)) assert.ok(!/\d[\d,]{2,}/.test(label), `${id} label looks like a number: ${label}`);
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'topcoat-publication-'));
  for (const name of [...manifest.files, 'estimator/index.html', 'estimator/assets/index-test.js']) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), name);
  }
  await writeFile(join(root, 'SCHEMA.md'), 'private schema');
  return root;
}

test('publication preserves approved assets byte-for-byte and omits internal files', async () => {
  const root = await fixture();
  try {
    const paths = await buildPublicSite(root);
    for (const path of paths) assert.equal(await readFile(join(root, 'dist', path), 'utf8'), path);
    await assert.rejects(access(join(root, 'dist', 'SCHEMA.md')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unexpected generated file and symbolic link fail before publication', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'estimator', 'notes.md'), 'internal');
    await assert.rejects(buildPublicSite(root), /not approved/);
    await rm(join(root, 'estimator', 'notes.md'));
    await symlink(join(root, 'SCHEMA.md'), join(root, 'estimator', 'assets', 'secret.js'));
    await assert.rejects(buildPublicSite(root), /symbolic links/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

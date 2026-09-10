'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatSelection, mdToSafeHtml, inlineHtml, scopePlainText } = require('./estimate-formatting.cjs');
const { scopeSendBlockers } = require('./optional-lines.cjs');
const { estimatePage } = require('../netlify/functions/pec-public-estimate.cjs')._internals;

test('bold and italic preserve selection, toggle, and combine', () => {
  const bold = formatSelection('Prep coat now', 5, 9, 'bold');
  assert.equal(bold.value, 'Prep **coat** now');
  assert.equal(bold.value.slice(bold.selectionStart, bold.selectionEnd), 'coat');
  assert.equal(formatSelection(bold.value, bold.selectionStart, bold.selectionEnd, 'bold').value, 'Prep coat now');
  const both = formatSelection(bold.value, bold.selectionStart, bold.selectionEnd, 'italic');
  assert.equal(both.value, 'Prep ***coat*** now');
  assert.match(mdToSafeHtml(both.value), /<strong><em>coat<\/em><\/strong>/);
  assert.equal(formatSelection(both.value, both.selectionStart, both.selectionEnd, 'italic').value, bold.value);
  assert.equal(formatSelection('**coat**', 0, 8, 'italic').value, '***coat***');
  assert.equal(formatSelection('coat ', 0, 5, 'bold').value, '**coat** ');
});

test('empty selection is a no-op and ordinary text stays unchanged', () => {
  const empty = formatSelection('', 0, 0, 'italic');
  assert.deepEqual(empty, { value: '', selectionStart: 0, selectionEnd: 0 });
  assert.equal(mdToSafeHtml('Prep & coat 600 sq ft.'), '<p style="margin:6px 0">Prep &amp; coat 600 sq ft.</p>');
  assert.equal(mdToSafeHtml(''), '');
});

test('list controls affect whole selected lines, toggle, and switch list type', () => {
  const bullets = formatSelection('Prep\nCoat\nLeave this', 0, 10, 'bullet');
  assert.equal(bullets.value, '- Prep\n- Coat\nLeave this');
  assert.equal(formatSelection(bullets.value, bullets.selectionStart, bullets.selectionEnd, 'bullet').value, 'Prep\nCoat\nLeave this');
  const numbered = formatSelection(bullets.value, bullets.selectionStart, bullets.selectionEnd, 'numbered');
  assert.equal(numbered.value, '1. Prep\n2. Coat\nLeave this');
  assert.equal(formatSelection('Prep\nCoat', 6, 6, 'bullet').value, 'Prep\n- Coat');
  assert.equal(formatSelection('\nPrep', 0, 0, 'bullet').value, '\nPrep');
  assert.equal(formatSelection('Prep\n\nCoat', 0, 10, 'numbered').value, '1. Prep\n\n2. Coat');
});

test('formatting several lines keeps list markers outside emphasis', () => {
  const result = formatSelection('- Prep\n- Coat\n\n### Notes', 0, 24, 'bold');
  assert.equal(result.value, '- **Prep**\n- **Coat**\n\n### **Notes**');
  assert.match(mdToSafeHtml(result.value), /<li[^>]*><strong>Prep<\/strong><\/li>/);
  assert.equal(formatSelection('- Prep', 0, 6, 'bold').value, '- **Prep**');
  assert.equal(formatSelection('- **Prep**', 0, 10, 'bold').value, '- Prep');
  const multiple = '**Prep** and **Coat**';
  assert.equal(formatSelection(multiple, 0, multiple.length, 'bold').value, '**Prep and Coat**');
});

test('formatting cannot fill a blank scope or hide the existing footage-only send blocker', () => {
  for (const command of ['bold', 'italic', 'bullet', 'numbered']) {
    assert.equal(formatSelection('', 0, 0, command).value, '');
    assert.equal(formatSelection(' \n ', 0, 3, command).value, ' \n ');
  }
  for (const description of ['', ' ', '** **', '- ', '1. ', '---', '**970 sqft**', '- *970 sqft*']) {
    const blockers = scopeSendBlockers({ items: [{ label: 'Garage', estimate_area_id: 'area', description }] });
    assert.ok(blockers.length > 0, description);
  }
  assert.equal(scopePlainText('- **Prepare** the *floor*'), 'Prepare the floor');
  assert.equal(scopePlainText('**<script>** & quoted'), '<script> & quoted');
  for (const description of ['BL**ANK**', '*is* / is not', '{**{AREA}**}', '_**__**']) {
    assert.ok(scopeSendBlockers({ items: [{ label: 'Garage', estimate_area_id: 'area', description }] }).length > 0, description);
    assert.ok(scopeSendBlockers({ items: [], scopeOfWork: description }).length > 0, `document: ${description}`);
  }
  assert.deepEqual(scopeSendBlockers({ items: [{ label: 'Garage', estimate_area_id: 'area', description: '- **Prepare** the *floor*' }] }), []);
});

test('legacy headings, bullets, rules and emphasis render safely with new nested styles', () => {
  const html = mdToSafeHtml('## Preparation\n**Keep this**\n- Grind\n* Clean\n---\n### Cure\nKeep *dry*.\n1. Apply\n2. Protect');
  assert.match(html, /font-weight:800/);
  assert.match(html, /<strong>Keep this<\/strong>/);
  assert.match(html, /<ul[^>]*><li[^>]*>Grind<\/li><li[^>]*>Clean<\/li><\/ul>/);
  assert.match(html, /<hr /);
  assert.match(html, /<em>dry<\/em>/);
  assert.match(html, /<ol[^>]*><li[^>]*>Apply<\/li><li[^>]*>Protect<\/li><\/ol>/);
  assert.equal(inlineHtml('**Prep *carefully***'), '<strong>Prep <em>carefully</em></strong>');
  assert.equal(inlineHtml('*Use **care** here*'), '<em>Use <strong>care</strong> here</em>');
  assert.equal(inlineHtml('10 * 20 * 30'), '10 * 20 * 30');
  assert.equal(inlineHtml('Unclosed **text'), 'Unclosed **text');
  assert.equal(inlineHtml('\\*literal\\*'), '*literal*');
  assert.match(mdToSafeHtml('3. Third\n4. Fourth\n- Bullet'), /<ol start="3"/);
});

test('pasted HTML, entity tricks, and links cannot introduce executable HTML', () => {
  const text = '**<img src=x onerror="alert(1)">**\n*<script>alert(2)</script>*\n- &lt;svg onload=alert(3)&gt;\n1. [click](javascript:alert(4))';
  const html = mdToSafeHtml(text);
  assert.doesNotMatch(html, /<(?:img|script|svg|a)\b/i);
  assert.match(html, /<strong>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/strong>/);
  assert.match(html, /&amp;lt;svg/);
  assert.match(html, /\[click\]\(javascript:alert\(4\)\)/);
});

test('customer, staff preview, and print all render the same formatted scope', () => {
  const description = '- **Prepare** the floor\n- Keep it *dry*\n\n1. Coat\n2. Cure\n<script>neverRun()</script>';
  const expected = mdToSafeHtml(description);
  const estimate = {
    id: 'formatting-fixture', status: 'sent', sent_at: '2026-09-10T12:00:00Z',
    public_token: 'fixture-token', customer_name: 'Test Customer', price: 2400,
    line_items: [{ id: 'line', label: 'Garage', description, qty: 1, unit_price: 2400, total: 2400 }],
  };
  for (const opts of [{}, { preview: true }, { print: true }]) {
    const response = estimatePage(estimate, {}, opts);
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes(expected));
    assert.ok(!response.body.includes('<script>neverRun()'));
  }
});

test('dashboard formatting and visible-text validation mirror the canonical renderer', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const mirror = dashboard.split('// BEGIN shared estimate formatting mirror')[1].split('// END shared estimate formatting mirror.')[0];
  const source = mirror.slice(mirror.indexOf('const pecScopeFormatting'));
  const actual = vm.runInNewContext(`${source}\npecScopeFormatting`, {}, { timeout: 1000 });
  const corpus = ['', null, 'Plain & unchanged', '- ', '1. ', '**970 sqft**', '{{AREA}}', '___', '# Heading\n---\n**Bold** and *italic*\n- One\n2. Two', '<script>alert(1)</script>', '**Prep *carefully***', '*Use **care** here*'];
  const fragments = ['Prep', '*', '**', '\\*', '\n', '- ', '1. ', '<img onerror=x>', '&lt;script&gt;', ' ', '_', '{{AREA}}'];
  for (let i = 0; i < 120; i++) corpus.push(Array.from({ length: 12 }, (_, j) => fragments[(i * 7 + j * 5 + Math.floor(i / 12)) % fragments.length]).join(''));
  for (const value of corpus) {
    assert.equal(actual.mdToSafeHtml(value), mdToSafeHtml(value));
    assert.equal(actual.scopePlainText(value), scopePlainText(value));
  }
  assert.doesNotThrow(() => mdToSafeHtml(Array(12000).fill('**a ').join('')));
});

test('invoice, invoice email, dashboard email preview and job PDF descriptions preserve formatting', () => {
  const ts = require('../apps/estimator/node_modules/typescript');
  const root = path.join(__dirname, '..');
  const getFunction = (file, name) => {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = file.endsWith('.html') ? [...contents.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]) : [contents];
    for (const script of scripts) {
      const parsed = ts.createSourceFile('test.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
      if (declaration) return declaration.getText(parsed);
    }
    throw new Error(`Function ${name} not found in ${file}`);
  };
  const description = '- **Prepare** the *floor*\n1. Coat\n2. Cure\n<img src=x onerror=bad()>';
  const expected = mdToSafeHtml(description);
  const esc = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { mdToSafeHtml, pecScopeMdToHtml: mdToSafeHtml, esc, usd: (n) => `$${n}`, invUSD: (n) => `$${n}`, invNum: Number, pecPrintBrand: () => ({}), pecInvoiceTermsLine: () => '', financingPdfHtml: () => '', Date };
  for (const [file, name] of [['netlify/functions/pec-public-invoice.cjs', 'lineItemsRows'], ['netlify/functions/pec-send-email.cjs', 'lineItemsTableHtml'], ['index.html', 'emailLineItemsTable']]) {
    const render = vm.runInNewContext(`${getFunction(file, name)}\n${name}`, ctx);
    const html = render([{ name: 'Garage', description, price: 2400 }]);
    assert.ok(html.includes(expected), name);
    assert.ok(!html.includes('<img'), name);
  }
  let printed = '';
  ctx.pecOpenPrintDoc = (_title, _brand, _head, body) => { printed = body; };
  const printInvoice = vm.runInNewContext(`${getFunction('index.html', 'pecDownloadInvoicePdf')}\npecDownloadInvoicePdf`, ctx);
  printInvoice({ id: 'fixture', line_items: [{ name: 'Garage', description, price: 2400 }], price: 2400 }, []);
  assert.ok(printed.includes(expected));
  const printEstimate = vm.runInNewContext(`${getFunction('index.html', 'pecDownloadEstimatePdf')}\npecDownloadEstimatePdf`, ctx);
  printEstimate({ id: 'fixture', customer_name: 'Test' }, [{ name: 'Garage', description, price: 2400 }], 2400, () => 'Flake');
  assert.ok(printed.includes(expected));
});

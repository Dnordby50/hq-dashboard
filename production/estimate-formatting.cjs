'use strict';

// Scope stays plain text with lightweight formatting in the existing offline
// payloads. Only this renderer creates HTML; pasted or typed HTML is escaped.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function parseInline(value) {
  const text = String(value);
  const root = { children: [] };
  const stack = [root];
  const append = (part) => stack[stack.length - 1].children.push(part);
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[\\*]/.test(text[i + 1] || '')) {
      append(text[i + 1]); i += 2; continue;
    }
    if (text[i] !== '*') { append(text[i++]); continue; }
    let end = i;
    while (text[end] === '*') end++;
    let remaining = end - i;
    const canClose = i > 0 && !/\s/.test(text[i - 1]);
    const canOpen = end < text.length && !/\s/.test(text[end]);
    if (remaining <= 3 && canClose) {
      while (stack.length > 1 && remaining >= stack[stack.length - 1].size) {
        const node = stack.pop();
        node.closed = true;
        remaining -= node.size;
      }
    }
    if (remaining <= 3 && canOpen) {
      while (remaining > 0) {
        const size = remaining >= 2 ? 2 : 1;
        const node = { size, children: [], closed: false };
        append(node); stack.push(node); remaining -= size;
      }
    }
    if (remaining) append('*'.repeat(remaining));
    i = end;
  }
  return root.children;
}

function renderInline(parts, dropStyle) {
  const out = [];
  const pending = parts.slice().reverse();
  while (pending.length) {
    const part = pending.pop();
    if (typeof part === 'string') { out.push(dropStyle ? part : escapeHtml(part)); continue; }
    if (part.end) { out.push(part.end); continue; }
    const marker = '*'.repeat(part.size);
    if (dropStyle) {
      if (!part.closed || part.size !== dropStyle) {
        out.push(marker);
        if (part.closed) pending.push({ end: marker });
      }
    } else if (part.closed) {
      const tag = part.size === 2 ? 'strong' : 'em';
      out.push(`<${tag}>`); pending.push({ end: `</${tag}>` });
    } else out.push(marker);
    for (let i = part.children.length - 1; i >= 0; i--) pending.push(part.children[i]);
  }
  return out.join('');
}

function inlineHtml(value) {
  return renderInline(parseInline(value));
}

function mdToSafeHtml(value) {
  const out = [];
  let list = null;
  const flushList = () => {
    if (!list) return;
    const start = list.kind === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
    out.push(`<${list.kind}${start} style="margin:6px 0 10px;padding-left:20px">${list.items.join('')}</${list.kind}>`);
    list = null;
  };
  for (const raw of String(value == null ? '' : value).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(`<li style="margin:2px 0">${inlineHtml(bullet ? bullet[1] : numbered[2])}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    if (/^---+$/.test(line.trim())) { out.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">'); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(`<div style="font-weight:800;font-size:${heading[1].length <= 2 ? '15px' : '13.5px'};margin:14px 0 6px">${inlineHtml(heading[2])}</div>`);
    } else out.push(`<p style="margin:6px 0">${inlineHtml(line)}</p>`);
  }
  flushList();
  return out.join('');
}

// Pure selection transforms keep the browser selection and the saved value in
// agreement. Buttons never save a second representation or mutate HTML.
function scopePlainText(value) {
  const text = String(value == null ? '' : value).split(/\r?\n/)
    .map((line) => /^\s*(?:[-*#\s]+|\d+[.)])\s*$/.test(line) ? '' : line).join('\n');
  return mdToSafeHtml(text).replace(/<\/(?:p|div|li|ul|ol)>|<hr[^>]*>/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]))
    .replace(/\s+/g, ' ').trim();
}

function formatSelection(value, selectionStart, selectionEnd, command) {
  const text = String(value == null ? '' : value);
  let start = Math.max(0, Math.min(text.length, selectionStart || 0));
  let end = Math.max(start, Math.min(text.length, selectionEnd == null ? start : selectionEnd));
  if (command === 'bold' || command === 'italic') {
    const marker = command === 'bold' ? '**' : '*';
    const size = marker.length;
    const selected = text.slice(start, end);
    if (!selected.trim()) return { value: text, selectionStart: start, selectionEnd: end };
    if (selected.includes('\n') || /^(?:\s*(?:[-*]|\d+[.)])\s+|#{1,4}\s+)/.test(selected)) {
      const formatted = selected.split('\n').map((line) => {
        if (!line.trim()) return line;
        const prefix = (line.match(/^(?:\s*(?:[-*]|\d+[.)])\s+|#{1,4}\s+)/) || [''])[0];
        return prefix + formatSelection(line.slice(prefix.length), 0, line.length - prefix.length, command).value;
      }).join('\n');
      return { value: text.slice(0, start) + formatted + text.slice(end), selectionStart: start, selectionEnd: start + formatted.length };
    }
    // Keep surrounding whitespace outside emphasis so it renders correctly.
    if (selected.trim()) {
      start += selected.length - selected.trimStart().length;
      end -= selected.length - selected.trimEnd().length;
    }
    const body = text.slice(start, end);
    const hasStyle = (stars) => command === 'bold' ? stars === 2 || stars === 3 : stars === 1 || stars === 3;
    const parts = parseInline(body);
    const fullyStyled = parts.length === 1 && typeof parts[0] !== 'string' && parts[0].closed && (parts[0].size === size || (size === 1 && parts[0].children.length === 1 && parts[0].children[0].size === 1 && parts[0].children[0].closed));
    if (fullyStyled) {
      const content = renderInline(parts, size);
      return { value: text.slice(0, start) + content + text.slice(end), selectionStart: start, selectionEnd: start + content.length };
    }
    if (hasStyle((text.slice(0, start).match(/\*+$/) || [''])[0].length) && hasStyle((text.slice(end).match(/^\*+/) || [''])[0].length)) {
      return { value: text.slice(0, start - size) + body + text.slice(end + size), selectionStart: start - size, selectionEnd: end - size };
    }
    const content = renderInline(parts, size);
    return { value: text.slice(0, start) + marker + content + marker + text.slice(end), selectionStart: start + size, selectionEnd: start + size + content.length };
  }
  if (command !== 'bullet' && command !== 'numbered') return { value: text, selectionStart: start, selectionEnd: end };
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = text.indexOf('\n', last);
  const to = nextBreak < 0 ? text.length : nextBreak;
  const lines = text.slice(from, to).split('\n');
  if (!lines.some((line) => line.trim())) return { value: text, selectionStart: start, selectionEnd: end };
  const marker = command === 'bullet' ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
  const remove = lines.filter((line) => line.trim()).every((line) => marker.test(line)) && lines.some((line) => line.trim());
  let number = 0;
  const changed = lines.map((line) => {
    if (!line.trim()) return line;
    if (remove) return line.replace(marker, '');
    const content = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
    return (command === 'bullet' ? '- ' : `${++number}. `) + content;
  }).join('\n');
  return { value: text.slice(0, from) + changed + text.slice(to), selectionStart: from, selectionEnd: from + changed.length };
}

module.exports = { mdToSafeHtml, inlineHtml, scopePlainText, formatSelection };

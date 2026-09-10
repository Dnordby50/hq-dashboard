import { useId, useRef } from 'react';
import { formatSelection, mdToSafeHtml, type FormatCommand } from '../../../../../production/estimate-formatting.cjs';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
  sheetDescription?: boolean;
  label?: string;
};

export default function ScopeEditor({ value, onChange, placeholder, rows = 7, sheetDescription, label = 'Description' }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const apply = (command: FormatCommand) => {
    const field = textarea.current;
    if (!field) return;
    const result = formatSelection(value, field.selectionStart, field.selectionEnd, command);
    onChange(result.value);
    requestAnimationFrame(() => {
      field.focus({ preventScroll: true });
      field.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };
  return <div className="scope-editor">
    <div className="scope-editor-toolbar" role="group" aria-label="Text formatting">
      <button type="button" title="Bold (Ctrl or Command+B)" aria-label="Bold" disabled={!value.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => apply('bold')}><strong>B</strong></button>
      <button type="button" title="Italic (Ctrl or Command+I)" aria-label="Italic" disabled={!value.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => apply('italic')}><em>I</em></button>
      <button type="button" disabled={!value.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => apply('bullet')}>• Bullets</button>
      <button type="button" disabled={!value.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => apply('numbered')}>1. Numbered list</button>
    </div>
    <textarea
      ref={textarea}
      className="custom-scope"
      data-sheet-desc={sheetDescription ? '1' : undefined}
      aria-label={label}
      aria-describedby={hintId}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && ['b', 'i'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          apply(e.key.toLowerCase() === 'b' ? 'bold' : 'italic');
        }
      }}
    />
    <p className="hint" id={hintId}>Select text to format it. The preview shows how it will look on the estimate.</p>
    <div className="scope-editor-preview" aria-label={`${label} preview`}>
      <span className="scope-editor-preview-label">Preview</span>
      {value.trim()
        ? <div className="scope-editor-preview-content" dangerouslySetInnerHTML={{ __html: mdToSafeHtml(value) }} />
        : <p className="hint">Your formatted description will appear here.</p>}
    </div>
  </div>;
}

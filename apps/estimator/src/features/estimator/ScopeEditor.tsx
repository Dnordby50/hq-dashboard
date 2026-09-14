import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorView } from 'prosemirror-view';
import { toggleMark } from 'prosemirror-commands';
import { closeHistory, redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import type { Command, EditorState } from 'prosemirror-state';
import { createScopeEditorState, markdownToScopeDoc, scopeDocToMarkdown, scopeSchema, selectedScopeList, toggleScopeList } from '../../lib/scopeRichText';
import DescriptionTemplates, { type DescriptionTemplateOptions } from './DescriptionTemplates';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
  sheetDescription?: boolean;
  label?: string;
  templateOptions?: DescriptionTemplateOptions;
};

export default function ScopeEditor({ value, onChange, placeholder, rows = 7, sheetDescription, label = 'Description', templateOptions }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latestValue = useRef(value); latestValue.current = value;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const lastEmitted = useRef(value);
  const hintId = useId();
  const [tools, setTools] = useState({ bold: false, italic: false, list: null as 'bullet_list' | 'ordered_list' | null, undo: false, redo: false });
  const updateTools = (state: EditorState) => {
    const { from, to, empty, $from } = state.selection;
    const marked = (name: 'strong' | 'em') => empty
      ? !!scopeSchema.marks[name].isInSet(state.storedMarks || $from.marks())
      : state.doc.rangeHasMark(from, to, scopeSchema.marks[name]);
    setTools({ bold: marked('strong'), italic: marked('em'), list: selectedScopeList(state), undo: undoDepth(state) > 0, redo: redoDepth(state) > 0 });
  };

  useLayoutEffect(() => {
    if (!mount.current) return;
    const view = new EditorView(mount.current, {
      state: createScopeEditorState(latestValue.current, mount.current.ownerDocument),
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction);
        view.updateState(next);
        updateTools(next);
        if (transaction.docChanged && !transaction.getMeta('scopeExternalValue')) {
          const markdown = scopeDocToMarkdown(next.doc);
          lastEmitted.current = markdown;
          onChangeRef.current(markdown);
        }
      },
    });
    editor.current = view;
    updateTools(view.state);
    return () => { editor.current = null; view.destroy(); };
  }, []);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    view.setProps({ attributes: state => ({
      class: 'scope-editor-content', role: 'textbox', tabindex: '0', 'aria-multiline': 'true',
      'aria-label': label, 'aria-describedby': hintId, 'data-placeholder': placeholder,
      'data-empty': state.doc.textContent ? 'false' : 'true',
      ...(sheetDescription ? { 'data-sheet-desc': '1' } : {}),
    }) });
  }, [label, hintId, placeholder, sheetDescription]);

  useLayoutEffect(() => {
    const view = editor.current;
    // Parent autosave echoes must not replace the document or its selection.
    if (!view || value === lastEmitted.current) return;
    lastEmitted.current = value;
    const next = markdownToScopeDoc(value, view.dom.ownerDocument);
    if (next.eq(view.state.doc)) return;
    // A template/parent replacement is one undoable edit. Do not emit a
    // second onChange merely to normalize externally supplied markdown.
    const transaction = closeHistory(view.state.tr.replaceWith(0, view.state.doc.content.size, next.content))
      .setMeta('scopeExternalValue', true);
    view.dispatch(transaction);
  }, [value]);

  const apply = (command: Command) => {
    const view = editor.current;
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  };

  return <div className="scope-editor">
    {templateOptions && <DescriptionTemplates {...templateOptions} value={value} onApply={onChange} />}
    <div className="scope-editor-toolbar" role="group" aria-label="Text formatting">
      <button type="button" title="Bold (Ctrl or Command+B)" aria-label="Bold" aria-pressed={tools.bold} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(toggleMark(scopeSchema.marks.strong))}><strong>B</strong></button>
      <button type="button" title="Italic (Ctrl or Command+I)" aria-label="Italic" aria-pressed={tools.italic} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(toggleMark(scopeSchema.marks.em))}><em>I</em></button>
      <button type="button" aria-pressed={tools.list === 'bullet_list'} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(toggleScopeList('bullet_list'))}>• Bullets</button>
      <button type="button" aria-pressed={tools.list === 'ordered_list'} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(toggleScopeList('ordered_list'))}>1. Numbered list</button>
      <button type="button" title="Undo (Ctrl or Command+Z)" disabled={!tools.undo} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(undo)}>Undo</button>
      <button type="button" title="Redo (Ctrl or Command+Shift+Z)" disabled={!tools.redo} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(redo)}>Redo</button>
    </div>
    <div ref={mount} className="scope-editor-document" style={{ '--scope-editor-min-height': `${Math.max(3, rows) * 1.5 + 1.5}em` } as CSSProperties} />
    <p className="hint" id={hintId}>Type and format your description here. Select text for bold or italic, or use a list for steps.</p>
  </div>;
}

import { DOMParser, Schema, type Node as RichNode } from 'prosemirror-model';
import { EditorState, type Command } from 'prosemirror-state';
import { baseKeymap, chainCommands, splitBlock, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown';
import { mdToSafeHtml } from '../../../../production/estimate-formatting.cjs';

// Deliberately no links, images, styles, arbitrary HTML or nested lists. This
// is the same formatting vocabulary our saved descriptions already support.
export const scopeSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    heading: { attrs: { level: { default: 1 } }, content: 'inline*', group: 'block', defining: true,
      parseDOM: [1, 2, 3, 4].map(level => ({ tag: `h${level}`, attrs: { level } })), toDOM: node => [`h${node.attrs.level}`, 0] },
    horizontal_rule: { group: 'block', parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
    bullet_list: { content: 'list_item+', group: 'block', attrs: { bullet: { default: '-' } },
      parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } },
      parseDOM: [{ tag: 'ol', getAttrs: dom => ({ order: Number((dom as HTMLElement).getAttribute('start')) || 1 }) }],
      toDOM: node => ['ol', node.attrs.order === 1 ? {} : { start: node.attrs.order }, 0] },
    list_item: { content: 'paragraph+', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
    text: { group: 'inline' },
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight', getAttrs: value => /^(bold(er)?|[5-9]00)$/.test(String(value)) ? null : false }], toDOM: () => ['strong', 0] },
    em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }], toDOM: () => ['em', 0] },
  },
});

export function markdownToScopeDoc(value: string, ownerDocument: Document): RichNode {
  const holder = ownerDocument.createElement('div');
  holder.innerHTML = mdToSafeHtml(value);
  // The customer renderer uses styled divs for headings. Recover their
  // original levels so editing a legacy heading keeps its markdown shape.
  const headingLevels = value.split(/\r?\n/).map(line => line.match(/^(#{1,4})\s+/)?.[1].length).filter(Boolean) as number[];
  holder.querySelectorAll('div').forEach((element, index) => {
    const heading = ownerDocument.createElement(`h${headingLevels[index] || 2}`);
    while (element.firstChild) heading.appendChild(element.firstChild);
    element.replaceWith(heading);
  });
  return DOMParser.fromSchema(scopeSchema).parse(holder);
}

const serializer = new MarkdownSerializer(defaultMarkdownSerializer.nodes, {
  strong: defaultMarkdownSerializer.marks.strong,
  em: defaultMarkdownSerializer.marks.em,
});

export function scopeDocToMarkdown(doc: RichNode): string {
  // Our renderer already treats each ordinary line as a paragraph and
  // ignores blank separators. Keep existing descriptions compact on edits.
  return serializer.serialize(doc, { tightLists: true }).replace(/\n{2,}/g, '\n');
}

export function selectedScopeList(state: EditorState): 'bullet_list' | 'ordered_list' | null {
  for (let depth = state.selection.$from.depth; depth > 0; depth--) {
    const name = state.selection.$from.node(depth).type.name;
    if (name === 'bullet_list' || name === 'ordered_list') return name;
  }
  return null;
}

export function toggleScopeList(kind: 'bullet_list' | 'ordered_list'): Command {
  return (state, dispatch, view) => {
    const current = selectedScopeList(state);
    if (current === kind) return liftListItem(scopeSchema.nodes.list_item)(state, dispatch, view);
    if (current) {
      for (let depth = state.selection.$from.depth; depth > 0; depth--) {
        if (state.selection.$from.node(depth).type.name === current) {
          if (dispatch) dispatch(state.tr.setNodeMarkup(state.selection.$from.before(depth), scopeSchema.nodes[kind]));
          return true;
        }
      }
    }
    return wrapInList(scopeSchema.nodes[kind])(state, dispatch, view);
  };
}

export function createScopeEditorState(value: string, ownerDocument: Document): EditorState {
  return EditorState.create({
    doc: markdownToScopeDoc(value, ownerDocument),
    plugins: [history(), keymap({
      'Mod-b': toggleMark(scopeSchema.marks.strong),
      'Mod-i': toggleMark(scopeSchema.marks.em),
      'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
      'Mod-Shift-7': toggleScopeList('ordered_list'),
      'Mod-Shift-8': toggleScopeList('bullet_list'),
      Enter: chainCommands(splitListItem(scopeSchema.nodes.list_item), baseKeymap.Enter),
      'Shift-Enter': chainCommands(splitListItem(scopeSchema.nodes.list_item), splitBlock),
    }), keymap(baseKeymap)],
  });
}

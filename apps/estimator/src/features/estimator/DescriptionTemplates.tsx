import { useEffect, useRef, useState } from 'react';
import { canSaveLineTemplates, getCachedLineTemplates, loadLineTemplates, saveLineTemplate, type LineTemplate } from '../../lib/lineTemplates';
import { uuid } from '../../offline/uuid';
import { mdToSafeHtml, scopePlainText } from '../../../../../production/estimate-formatting.cjs';

export type DescriptionTemplateOptions = {
  defaultName: string;
  createdBy: string | null;
  initialTemplates: LineTemplate[];
  online: boolean;
  onSaved: (template: LineTemplate) => void;
};

// This component is keyed by the line editor. A late save may finish on the
// server, but cannot alter the description or controls of a different line.
export default function DescriptionTemplates({ value, onApply, defaultName, createdBy, initialTemplates, online, onSaved }: DescriptionTemplateOptions & {
  value: string;
  onApply: (description: string) => void;
}) {
  const [mode, setMode] = useState<'save' | 'use' | null>(null);
  const [templates, setTemplates] = useState(initialTemplates);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<{ id: string; name: string; description: string } | null>(null);
  const [canSave, setCanSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const request = useRef(0);
  const saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  useEffect(() => { setTemplates(initialTemplates); }, [initialTemplates]);
  useEffect(() => {
    let current = true;
    setCanSave(false);
    if (online && createdBy) void canSaveLineTemplates().then(allowed => { if (current) setCanSave(allowed); }).catch(() => {});
    return () => { current = false; };
  }, [online, createdBy]);

  const beginSave = () => {
    request.current++;
    setLoading(false); setError(''); setNotice('');
    setDraft({ id: uuid(), name: defaultName.trim().slice(0, 160), description: value });
    setMode('save');
  };
  const beginUse = async () => {
    const token = ++request.current;
    setMode('use'); setSelectedId(''); setError(''); setNotice(''); setLoading(true);
    try {
      const found = online ? await loadLineTemplates() : await getCachedLineTemplates();
      if (!alive.current || request.current !== token) return;
      setTemplates(online || found.length ? found : initialTemplates);
    } catch (e) {
      if (alive.current && request.current === token) setError(e instanceof Error ? e.message : 'Could not load templates. Try again.');
    } finally {
      if (alive.current && request.current === token) setLoading(false);
    }
  };
  const save = async () => {
    if (!draft || !createdBy || !online || !canSave || saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const saved = await saveLineTemplate({ ...draft, createdBy });
      if (!alive.current) return;
      onSaved(saved);
      setTemplates(prev => [...prev.filter(t => t.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      setMode(null); setDraft(null); setNotice(`Saved “${saved.name}” as a description template.`);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not save the template. Try again.');
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const selected = templates.find(t => t.id === selectedId);
  const apply = () => {
    if (!selected || loading || error) return;
    if (value.trim() && value !== selected.description && !window.confirm('Replace this line’s current description with the selected template?')) return;
    onApply(selected.description);
    setMode(null); setNotice(`Applied “${selected.name}”. You can edit the description below.`);
  };
  const cancel = () => { request.current++; setMode(null); setError(''); setLoading(false); };

  return <div className="description-templates">
    <div className="description-template-actions">
      <button type="button" className="link" disabled={busy} onClick={() => void beginUse()}>Use template</button>
      <button type="button" className="link" disabled={busy || !online || !canSave || !scopePlainText(value).trim()} onClick={beginSave}
        title={!online ? 'Connect to save a new template' : !canSave ? 'Catalog editing access is required to save templates' : undefined}>Save as template</button>
    </div>
    {mode === 'save' && draft && <div className="description-template-panel">
      <label className="field"><span>Template name</span><input aria-label="Template name" maxLength={160} value={draft.name} disabled={busy}
        onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <p className="hint">Saves this description and its formatting for next time.</p>
      <div className="scope-editor-preview" aria-label="Description to save" dangerouslySetInnerHTML={{ __html: mdToSafeHtml(draft.description) }} />
      <div className="description-template-actions">
        <button type="button" className="sheet-done" disabled={busy || !draft.name.trim() || !online} onClick={() => void save()}>{busy ? 'Saving…' : 'Save template'}</button>
        <button type="button" className="link" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
    </div>}
    {mode === 'use' && <div className="description-template-panel">
      <label className="field"><span>Saved description templates</span><select aria-label="Saved description templates" value={selectedId} disabled={loading || !!error}
        onChange={e => setSelectedId(e.target.value)}>
        <option value="">{loading ? 'Loading templates…' : 'Choose a template…'}</option>
        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>
      {!loading && !error && !templates.length && <p className="hint">No templates saved yet. Write a description, then choose Save as template.</p>}
      {!online && <p className="hint">Showing templates saved on this device.</p>}
      {selected && <div className="scope-editor-preview" aria-label="Selected template preview" dangerouslySetInnerHTML={{ __html: mdToSafeHtml(selected.description) }} />}
      <div className="description-template-actions">
        <button type="button" className="sheet-done" disabled={!selected || loading || !!error} onClick={apply}>Use description</button>
        {error && <button type="button" className="link" onClick={() => void beginUse()}>Try again</button>}
        <button type="button" className="link" onClick={cancel}>Cancel</button>
      </div>
    </div>}
    {error && <p className="warn" role="alert">{error}</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
  </div>;
}

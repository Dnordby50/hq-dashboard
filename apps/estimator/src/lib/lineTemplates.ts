import { supabase } from './supabase';
import { idbGet, idbPut } from '../offline/idb';
import { scopePlainText } from '../../../../production/estimate-formatting.cjs';

export type LineTemplate = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
};

const TABLE = 'pec_estimate_line_templates';
const COLUMNS = 'id,name,description,active,created_by,created_at';
const CACHE_KEY = 'description-templates';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function templateValidationError(name: string, description: string): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Enter a template name.';
  if (name.trim().length > 160) return 'Keep the template name under 161 characters.';
  if (typeof description !== 'string' || !scopePlainText(description)) return 'Add a description before saving a template.';
  if (description.length > 30000) return 'Keep the template description under 30,001 characters.';
  return null;
}

function templateRow(value: unknown): LineTemplate {
  const row = value as Partial<LineTemplate> | null;
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id) ||
      typeof row.name !== 'string' || typeof row.description !== 'string' ||
      typeof row.active !== 'boolean' || typeof row.created_at !== 'string' ||
      (row.created_by !== null && (typeof row.created_by !== 'string' || !UUID.test(row.created_by)))) {
    throw new Error('The saved template could not be read. Try loading templates again.');
  }
  return { id: row.id, name: row.name, description: row.description, active: row.active, created_by: row.created_by, created_at: row.created_at };
}

async function cacheTemplates(rows: LineTemplate[]): Promise<void> {
  try { await idbPut('catalog', rows, CACHE_KEY); } catch { /* online success does not require offline storage */ }
}

export async function getCachedLineTemplates(): Promise<LineTemplate[]> {
  try {
    const rows = await idbGet<unknown>('catalog', CACHE_KEY);
    return Array.isArray(rows) ? rows.map(templateRow).filter(row => row.active) : [];
  } catch { return []; }
}

export async function loadLineTemplates(): Promise<LineTemplate[]> {
  const result = await supabase.from(TABLE).select(COLUMNS).eq('active', true).order('name').order('id');
  if (result.error) throw result.error;
  if (!Array.isArray(result.data)) throw new Error('Templates could not be loaded. Try again.');
  const rows = result.data.map(templateRow);
  await cacheTemplates(rows);
  return rows;
}

export async function canSaveLineTemplates(): Promise<boolean> {
  try {
    const [staff, permission] = await Promise.all([
      supabase.rpc('is_admin_staff'),
      supabase.rpc('has_permission', { p_perm: 'can_edit_catalog' }),
    ]);
    return !staff.error && !permission.error && staff.data === true && permission.data === true;
  } catch { return false; }
}

export async function saveLineTemplate(input: {
  id: string;
  name: string;
  description: string;
  createdBy: string | null;
}): Promise<LineTemplate> {
  const validation = templateValidationError(input.name, input.description);
  if (validation) throw new Error(validation);
  if (!UUID.test(input.id)) throw new Error('Start a new template and try saving again.');
  if (!input.createdBy || !UUID.test(input.createdBy)) throw new Error('Sign in again before saving a template.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Reconnect before saving a new template.');

  // The editor captures this ID once. INSERT never overwrites an existing
  // template, and a retry can verify an earlier write whose response was lost.
  const row = { id: input.id, name: input.name.trim(), description: input.description, active: true, created_by: input.createdBy };
  const confirm = async (value: unknown): Promise<LineTemplate> => {
    const saved = templateRow(value);
    if (saved.id !== row.id || saved.name !== row.name || saved.description !== row.description ||
        saved.created_by !== row.created_by || saved.active !== true) {
      throw new Error('This template was already saved with different content. Close it and save a new template.');
    }
    const cached = await getCachedLineTemplates();
    await cacheTemplates([...cached.filter(template => template.id !== saved.id), saved]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
    return saved;
  };

  let writeError: unknown;
  try {
    const result = await supabase.from(TABLE).insert(row).select(COLUMNS).maybeSingle();
    if (!result.error && result.data) return await confirm(result.data);
    writeError = result.error || new Error('The template save returned no record.');
  } catch (error) { writeError = error; }

  // Read verification is safe even after a timeout. There is no blind insert
  // retry and no upsert that could replace somebody else's template.
  const existing = await supabase.from(TABLE).select(COLUMNS).eq('id', row.id).maybeSingle();
  if (existing.error) throw new Error('Could not confirm the template was saved. Retry with this template still open.');
  if (existing.data) return confirm(existing.data);
  throw writeError instanceof Error ? writeError : new Error(
    typeof writeError === 'object' && writeError && 'message' in writeError
      ? String(writeError.message) : 'Could not save the template. Try again.',
  );
}

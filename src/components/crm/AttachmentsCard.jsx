import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function iconFor(mime = '', name = '') {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return '\u{1F5BC}\u{FE0F}';
  if (m === 'application/pdf' || name.endsWith('.pdf')) return '\u{1F4C4}';
  if (m.includes('spreadsheet') || /\.(xlsx?|csv)$/i.test(name)) return '\u{1F4CA}';
  if (m.includes('word') || /\.docx?$/i.test(name)) return '\u{1F4DD}';
  if (m.startsWith('audio/')) return '\u{1F50A}';
  if (m.startsWith('video/')) return '\u{1F3AC}';
  if (m.startsWith('text/')) return '\u{1F4C3}';
  return '\u{1F4CE}';
}
const isImg = (a) => (a.mime_type || '').toLowerCase().startsWith('image/');
const sourceLabel = (s) => s === 'inbound_email' ? ' · from email' : s === 'outbound_email' ? ' · sent' : '';

export default function AttachmentsCard({ subjectType, subjectId, profile }) {
  const [items, setItems] = useState([]);
  const [previews, setPreviews] = useState({}); // id -> signed thumbnail url (images only)
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [subjectType, subjectId]);

  const load = async () => {
    const { data } = await supabase.from('attachments')
      .select('*').eq('subject_type', subjectType).eq('subject_id', subjectId)
      .order('created_at', { ascending: false });
    const rows = data || [];
    setItems(rows);
    // Sign image paths so we can show real thumbnails (private bucket).
    const imgs = rows.filter(isImg);
    if (imgs.length) {
      const { data: signed } = await supabase.storage.from('attachments')
        .createSignedUrls(imgs.map(a => a.file_path), 3600);
      const map = {};
      (signed || []).forEach((s, i) => { if (s?.signedUrl) map[imgs[i].id] = s.signedUrl; });
      setPreviews(map);
    } else {
      setPreviews({});
    }
  };

  const onPick = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true); setError('');
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { setError(`${file.name} is over 25 MB`); continue; }
      const safe = file.name.replace(/[^\w.\-]+/g, '_');
      const path = `${subjectType}/${subjectId}/${crypto.randomUUID()}-${safe}`;
      const { error: upErr } = await supabase.storage.from('attachments').upload(path, file, {
        contentType: file.type || 'application/octet-stream', upsert: false,
      });
      if (upErr) { setError(upErr.message); continue; }
      const { error: insErr } = await supabase.from('attachments').insert({
        subject_type: subjectType, subject_id: subjectId,
        file_name: file.name, file_path: path,
        mime_type: file.type || null, size_bytes: file.size,
        uploaded_by: profile.id,
      });
      if (insErr) setError(insErr.message);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    load();
  };

  const download = async (a) => {
    // Open the tab synchronously (inside the click) BEFORE the await, or the
    // browser blocks it as a popup and nothing happens. Point it at the signed
    // URL once it resolves.
    const w = window.open('', '_blank');
    const { data, error: e } = await supabase.storage.from('attachments').createSignedUrl(a.file_path, 120);
    if (e || !data?.signedUrl) { if (w) w.close(); setError(e?.message || 'Could not open attachment.'); return; }
    if (w) w.location.href = data.signedUrl; else window.open(data.signedUrl, '_blank');
  };

  const remove = async (a) => {
    if (!confirm(`Delete "${a.file_name}"?`)) return;
    await supabase.storage.from('attachments').remove([a.file_path]);
    await supabase.from('attachments').delete().eq('id', a.id);
    load();
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-sm font-bold text-paper">Attachments</h3>
        <span className="text-xs text-dim font-mono">({items.length})</span>
        {canWrite && (
          <>
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="ml-auto text-xs text-ember hover:text-ember-deep font-medium disabled:opacity-50">
              {uploading ? 'Uploading…' : '+ Upload'}
            </button>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={onPick} />
          </>
        )}
      </div>
      <div className="p-4 space-y-2">
        {error && <div className="text-xs text-red-600">{error}</div>}
        {items.length === 0 && !error && <div className="text-xs text-dim italic py-2 text-center">No attachments</div>}
        {items.map(a => (
          <div key={a.id} className="flex items-center gap-2 p-2 glass-inner rounded-xl">
            {isImg(a) && previews[a.id] ? (
              <img src={previews[a.id]} alt={a.file_name} onClick={() => download(a)}
                className="w-12 h-12 rounded-lg object-cover shrink-0 cursor-pointer border border-bdr" />
            ) : (
              <span className="text-lg shrink-0">{iconFor(a.mime_type, a.file_name)}</span>
            )}
            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => download(a)}>
              <div className="text-sm text-paper truncate hover:text-ember transition">{a.file_name}</div>
              <div className="text-[10px] text-dim">
                {fmtSize(a.size_bytes)}{sourceLabel(a.source)}
              </div>
            </div>
            <button onClick={() => download(a)} className="text-xs text-ember hover:text-ember-deep shrink-0" title="Download">{'\u{2B07}'}</button>
            {canWrite && <button onClick={() => remove(a)} className="text-xs text-red-500 hover:text-red-600 shrink-0" title="Delete">{'\u{00D7}'}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

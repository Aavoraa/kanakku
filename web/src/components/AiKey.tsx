import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { ErrorBox, Modal } from './ui';
import { AiDataNotice } from './Privacy';

interface KeyStatus { enabled: boolean; model: string; hint: string | null; source: 'app' | 'environment' | null; canChange?: boolean }

/** Enter, replace or remove the Anthropic API key. The server checks it with Anthropic before saving. */
export function AiKeyDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [st, setSt] = useState<KeyStatus | null>(null);
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string } | null>(null);
  // The key serves every company on this computer, so only the administrator (the first account) changes it.
  const [canChange, setCanChange] = useState(false);

  useEffect(() => { void api.get<KeyStatus>('/api/v1/settings/ai-key').then((s) => { setSt(s); setCanChange(Boolean(s.canChange)); }).catch(() => {}); }, []);

  const fail = (e: unknown) => setErr({ message: e instanceof ApiError ? e.message : String(e) });
  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      setSt(await api.put<KeyStatus>('/api/v1/settings/ai-key', { apiKey: key.trim() }));
      setKey('');
      await app.refreshStatus();
      app.toast('AI is on: bill reading, workings and voice are ready');
      onClose();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Remove the API key? Bill reading from PDFs and photos, and voice, will stop until a key is added again.')) return;
    setBusy(true); setErr(null);
    try {
      setSt(await api.delete<KeyStatus>('/api/v1/settings/ai-key'));
      await app.refreshStatus();
      app.toast('API key removed; AI is off', 'info');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <Modal title="AI" onClose={onClose}>
      <div className="ai-key">
        {st?.enabled
          ? <p className="ok">AI is on{st.hint ? ` with key ${st.hint}` : ''} (model {st.model}).</p>
          : <p>AI reads PDF and photo bills, invoices, bank statements and free-form workings, and understands voice. Excel and CSV files work without it.</p>}

        {st?.source === 'environment' ? (
          <p className="muted">This key is set in the computer's environment variables, so it is changed there, not here.</p>
        ) : !canChange ? (
          <p className="muted">Only the administrator (the first account created on this computer) can change the API key.</p>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label>{st?.enabled ? 'Replace with a new API key' : 'Anthropic API key'}
              <span className="key-input">
                <input type={show ? 'text' : 'password'} value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…"
                  autoComplete="off" spellCheck={false} autoFocus />
                <button type="button" className="ghost" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
              </span>
            </label>
            <p className="muted small">Create one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com → API keys</a>.
              It is checked with Anthropic, then saved in the <code>.env</code> file in the project folder on this computer. The browser never gets it back.</p>
            <AiDataNotice />
            <ErrorBox error={err} />
            <div className="form-actions">
              {st?.enabled && st.source === 'app' && <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>Remove key</button>}
              <button type="submit" className="primary" disabled={busy || !key.trim()}>{busy ? 'Checking the key…' : st?.enabled ? 'Replace key' : 'Turn AI on'}</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FUNCTIONS, CONSTANTS } from '@core/expr/functions';
import { checkExpression, useExpressions, validateName } from '../../data/expressions';
import { useLogs } from '../../data/logs';

export interface ExprDraft { src: string; name: string; unit: string; saveAsNamed: boolean }

interface Suggestion { text: string; kind: 'channel' | 'function' | 'named' | 'constant'; detail: string; insert: string }

/**
 * Editor for an expression series: live validation with the error position
 * underlined, autocomplete (channels, functions, named expressions), and an
 * option to save the expression under a name for reuse.
 */
export function ExpressionEditor({ stream, initial, onDone, onCancel }: {
  stream: string;
  initial?: Partial<ExprDraft>;
  onDone: (d: ExprDraft) => void;
  onCancel: () => void;
}) {
  const named = useExpressions((s) => s.named);
  const logs = useLogs();
  const catalog = logs.logs[stream]?.summary?.channels ?? [];
  const [src, setSrc] = useState(initial?.src ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [saveAsNamed, setSaveAsNamed] = useState(initial?.saveAsNamed ?? false);
  const [cursor, setCursor] = useState(src.length);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  // Place the caret right after React commits a completion, before any further
  // keystrokes are handled (a deferred update would misplace fast typing).
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    inputRef.current?.setSelectionRange(pos, pos);
  });

  const error = useMemo(() => (src.trim() ? checkExpression(src, stream, named) : null), [src, stream, named]);
  const nameError = saveAsNamed ? validateName(name, named, initial?.saveAsNamed ? initial.name : undefined) : null;

  // Token being typed at the cursor.
  const before = src.slice(0, cursor);
  const tokMatch = /[A-Za-z_][A-Za-z0-9_[\].]*$/.exec(before);
  const token = tokMatch?.[0] ?? '';
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token || dismissed) return [];
    const q = token.toLowerCase();
    const out: Suggestion[] = [];
    for (const c of catalog) {
      const id = c.id.toLowerCase();
      if (id.startsWith(q) || (q.length >= 2 && id.includes(q)) || (c.label && c.label.toLowerCase().startsWith(q))) {
        out.push({ text: c.id, kind: 'channel', detail: `${c.label ? c.label + ' · ' : ''}${c.unit || '—'}`, insert: c.id });
      }
      if (out.length > 60) break;
    }
    for (const [fn, spec] of Object.entries(FUNCTIONS)) if (fn.startsWith(q)) out.unshift({ text: `${fn}(${spec.signature})`, kind: 'function', detail: spec.doc, insert: `${fn}(` });
    for (const [n, def] of Object.entries(named)) if (n.toLowerCase().startsWith(q)) out.unshift({ text: n, kind: 'named', detail: def, insert: n });
    for (const c of [...Object.keys(CONSTANTS), 't']) if (c.startsWith(q) && c !== q) out.push({ text: c, kind: 'constant', detail: c === 't' ? 'time (s)' : String(CONSTANTS[c]), insert: c });
    return out.slice(0, 40);
  }, [token, catalog, named, dismissed]);
  useEffect(() => { setSel(0); setDismissed(false); }, [token]);

  // Signature help: innermost unclosed call before the cursor.
  const sigHelp = useMemo(() => {
    let depth = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) {
          const m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before.slice(0, i));
          const spec = m && FUNCTIONS[m[1]!];
          return spec ? `${m![1]}(${spec.signature}) — ${spec.doc}` : null;
        }
        depth--;
      }
    }
    return null;
  }, [before]);

  const accept = (s: Suggestion) => {
    const start = cursor - token.length;
    const next = src.slice(0, start) + s.insert + src.slice(cursor);
    setSrc(next);
    const pos = start + s.insert.length;
    setCursor(pos);
    pendingCaret.current = pos;
  };

  const incomplete = !!error && error.start >= src.trimEnd().length;
  const canSubmit = !!src.trim() && !error && !nameError;
  const submit = () => canSubmit && onDone({ src: src.trim(), name: name.trim(), unit: unit.trim(), saveAsNamed });

  const onKey = (e: React.KeyboardEvent) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { setSel((s) => Math.min(suggestions.length - 1, s + 1)); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { setSel((s) => Math.max(0, s - 1)); e.preventDefault(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && token && suggestions[sel] && suggestions[sel]!.insert !== token)) {
        accept(suggestions[sel]!); e.preventDefault(); return;
      }
      if (e.key === 'Escape') { setDismissed(true); e.preventDefault(); return; }
    }
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter') submit();
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal expr-modal" role="dialog" aria-label="Expression">
        <h3>{initial?.src ? 'Edit expression' : 'Add expression'}</h3>
        <div className="expr-field">
          <input
            ref={inputRef} className="expr-input mono" value={src} spellCheck={false} aria-label="Expression"
            placeholder="e.g. ATT.Roll - ATT.DesRoll   ·   deriv(BARO.Alt)   ·   integrate(BAT.Curr) / 3600"
            onChange={(e) => { setSrc(e.target.value); setCursor(e.target.selectionStart ?? e.target.value.length); }}
            onSelect={(e) => setCursor((e.target as HTMLInputElement).selectionStart ?? 0)}
            onKeyDown={onKey}
          />
          {error && (
            <div className="expr-underline mono" aria-hidden>
              <span style={{ visibility: 'hidden' }}>{src.slice(0, error.start)}</span>
              <span className="squiggle">{src.slice(error.start, Math.max(error.end, error.start + 1)) || ' '}</span>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="expr-suggest" role="listbox">
              {suggestions.map((s, k) => (
                <div key={s.kind + s.text} role="option" aria-selected={k === sel} className={k === sel ? 'pick sel' : 'pick'}
                  onMouseEnter={() => setSel(k)} onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
                  <span className={`sug-kind k-${s.kind}`}>{s.kind === 'function' ? 'ƒ' : s.kind === 'named' ? '≡' : s.kind === 'constant' ? 'π' : '∿'}</span>
                  <span className="pick-id">{s.text}</span>
                  <span className="pick-meta">{s.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* While a call is still being typed, "ends too early" is noise: show the signature instead. */}
        <div className={`expr-msg ${error && !(incomplete && sigHelp) ? 'err' : incomplete && sigHelp ? 'hint' : 'ok'}`}>
          {!src.trim() ? <span className="muted">Type an expression. Tab completes; channels need a dot (ATT.Roll, IMU[1].AccZ).</span>
            : error ? (incomplete && sigHelp ? sigHelp : error.message) : sigHelp ?? '✓ Valid'}
        </div>
        {error && sigHelp && !incomplete && <div className="muted expr-sig">{sigHelp}</div>}
        <div className="expr-row">
          <label>Label <input value={name} onChange={(e) => setName(e.target.value)} placeholder={saveAsNamed ? 'name (required)' : 'optional'} aria-label="Label" /></label>
          <label>Unit <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. W" style={{ width: 70 }} aria-label="Unit" /></label>
          <label className="chk"><input type="checkbox" checked={saveAsNamed} onChange={(e) => setSaveAsNamed(e.target.checked)} /> Save as a named expression</label>
        </div>
        {nameError && <div className="err expr-msg">{nameError}</div>}
        <details className="expr-help">
          <summary>Functions</summary>
          <div className="fn-grid">
            {Object.entries(FUNCTIONS).map(([fn, s]) => <div key={fn}><code>{fn}({s.signature})</code> <span className="muted">{s.doc}</span></div>)}
            <div><code>+ − * / % ^</code> <span className="muted">arithmetic</span></div>
            <div><code>&lt; &gt; == != &amp;&amp; || ! a ? b : c</code> <span className="muted">comparisons give 1/0</span></div>
            <div><code>t, pi, e, g</code> <span className="muted">time (s), constants (g = 9.80665)</span></div>
          </div>
        </details>
        <div className="modal-actions">
          <span className="muted">Mixed rates are resampled onto the fastest input.</span>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!canSubmit}>{initial?.src ? 'Update' : 'Add'}</button>
        </div>
      </div>
    </div>
  );
}

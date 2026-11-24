import { useState } from 'react';
import type { ReadoutLine } from './model';
import { BUILT_IN_PRESETS, deletePreset, presetLines, savePreset, usePresets } from './presets';

/** Readout presets: apply one (replace or add lines), save the current lines as a preset, update or delete your own. */
export function PresetBar({ lines, stream, onLines }: { lines: ReadoutLine[]; stream: string | undefined; onLines: (l: ReadoutLine[]) => void }) {
  const mine = usePresets((s) => s.mine);
  const [sel, setSel] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const preset = [...BUILT_IN_PRESETS, ...mine].find((p) => p.name === sel);
  const isMine = !!preset && !preset.builtIn;
  const doSave = () => {
    const name = (naming ?? '').trim();
    if (!name) return;
    savePreset(name, lines);
    setSel(name); setNaming(null);
  };
  return (
    <div className="oe-presets">
      <div className="oe-row">
        <label>Preset <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Readout preset">
          <option value="">— choose —</option>
          <optgroup label="Built-in">{BUILT_IN_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.lines.length})</option>)}</optgroup>
          {mine.length > 0 && <optgroup label="Mine">{mine.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.lines.length})</option>)}</optgroup>}
        </select></label>
        <button disabled={!preset} onClick={() => preset && onLines(presetLines(preset, stream))} title="Replace this readout's lines with the preset">Replace lines</button>
        <button disabled={!preset} onClick={() => preset && onLines([...lines, ...presetLines(preset, stream)])} title="Add the preset's lines below the current ones">Add lines</button>
      </div>
      <div className="oe-row">
        {naming === null
          ? <button onClick={() => setNaming(isMine ? `${sel} copy` : '')} disabled={!lines.length} title="Save this readout's lines as a preset of your own">Save lines as preset…</button>
          : <>
              <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') setNaming(null); }} placeholder="Preset name" aria-label="Preset name" style={{ width: 150 }} />
              <button className="primary" onClick={doSave} disabled={!naming.trim()}>Save</button>
              <button onClick={() => setNaming(null)}>Cancel</button>
              {naming.trim() && [...BUILT_IN_PRESETS, ...mine].some((p) => p.name === naming.trim()) && <span className="muted small">{BUILT_IN_PRESETS.some((p) => p.name === naming.trim()) ? 'same name as a built-in: yours is listed under Mine' : 'replaces your preset'}</span>}
            </>}
        {isMine && naming === null && <button onClick={() => savePreset(sel, lines)} title={`Overwrite "${sel}" with this readout's lines`}>Update “{sel}”</button>}
        {isMine && naming === null && <button onClick={() => { deletePreset(sel); setSel(''); }} title={`Delete your preset "${sel}"`}>Delete</button>}
      </div>
    </div>
  );
}

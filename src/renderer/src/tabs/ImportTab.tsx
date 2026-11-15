import { useApp } from '../store';

const fmtSize = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

export function ImportTab() {
  const { files, addFiles } = useApp();
  return (
    <div className="page">
      <h2>Import</h2>
      <p className="muted">
        Add DataFlash logs (.bin), MAVLink telemetry (.tlog), CSV sensor logs and ground videos.
        Parsing arrives in Phase 1; for now files are registered so other windows can open them.
      </p>
      <button onClick={async () => addFiles(await window.huskylog.openFiles())}>Add files…</button>
      {files.length > 0 && (
        <table className="files">
          <thead><tr><th>Name</th><th>Size</th><th>Path</th></tr></thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.path}><td>{f.name}</td><td>{fmtSize(f.size)}</td><td className="muted">{f.path}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

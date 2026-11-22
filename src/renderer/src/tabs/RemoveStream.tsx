import { useState } from 'react';
import { removalImpact, removeStream } from '../data/remove';

/** "×" that removes an imported log or video from the session, after a confirm. */
export function RemoveStreamButton({ id }: { id: string }) {
  const [asking, setAsking] = useState(false);
  const impact = asking ? removalImpact(id) : null;
  const what = impact?.kind === 'log' ? 'log' : 'video';
  return (
    <>
      <button className="row-x" title="Remove from this session" aria-label={`Remove ${id}`} onClick={() => setAsking(true)}>×</button>
      {asking && impact && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setAsking(false); }}>
          <div className="modal" role="dialog" aria-label="Remove from session">
            <h3>Remove {impact.name}?</h3>
            <p>The {what} leaves this session. The file on disk isn't touched, and you can add it again later.</p>
            <ul className="small">
              {impact.markers > 0 && <li>Its {impact.markers} sync marker{impact.markers === 1 ? '' : 's'} will be deleted (re-adding means syncing it again).</li>}
              {impact.kind === 'log' && <li>Graph lines from this log are removed{impact.readouts ? `, and ${impact.readouts} readout${impact.readouts === 1 ? '' : 's'} switch to the main log` : ''}.</li>}
              {impact.kind === 'video' && <li>Video windows showing it switch to another video.</li>}
            </ul>
            <div className="modal-actions">
              <button onClick={() => setAsking(false)}>Cancel</button>
              <button className="primary danger" onClick={() => { setAsking(false); removeStream(id); }}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

import { useCallback, useRef } from 'react';
import {
  DockviewReact, themeAbyss,
  type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelProps,
} from 'dockview-react';
import { Map3DPanel } from '../windows/Map3DPanel';
import { VideoPanel } from '../windows/VideoPanel';
import { GraphPanel } from '../windows/graph/GraphPanel';
import { MessagesPanel } from '../windows/MessagesPanel';
import { ParamsPanel } from '../windows/ParamsPanel';
import { TimelineBar } from '../windows/TimelineBar';

const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  map3d: Map3DPanel,
  video: VideoPanel,
  graph: GraphPanel as React.FunctionComponent<IDockviewPanelProps>,
  messages: MessagesPanel,
  params: ParamsPanel,
};

const TITLES: Record<string, string> = { map3d: '3D Map', video: 'Video', graph: 'Graph', messages: 'Messages', params: 'Parameters' };

/** Same-origin path to the empty pop-out shell (works for dev server and app://). */
const POPOUT_URL = '/popout.html';

function HeaderActions({ containerApi, group, location }: IDockviewHeaderActionsProps) {
  const inPopout = location?.type === 'popout';
  return (
    <div className="header-actions">
      {!inPopout && (
        <button title="Pop out to its own window" aria-label="Pop out"
          onClick={() => void containerApi.addPopoutGroup(group, { popoutUrl: POPOUT_URL })}>⧉</button>
      )}
      {location?.type === 'grid' && (
        <button title="Float over the grid" aria-label="Float" onClick={() => containerApi.addFloatingGroup(group)}>◱</button>
      )}
      {location?.type !== 'grid' && (
        <button title="Dock back into the grid" aria-label="Dock"
          onClick={() => group.api.moveTo({ position: 'right' })}>⇲</button>
      )}
    </div>
  );
}

let counter = 0;
export function addWindow(api: DockviewApi, type: string) {
  counter += 1;
  api.addPanel({ id: `${type}-${counter}`, component: type, title: TITLES[type] ?? type });
}

export function ReviewTab() {
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = useCallback((e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    (window.__hl as Record<string, unknown>)['dock'] = e.api;
    counter = 0;
    e.api.addPanel({ id: 'map3d-0', component: 'map3d', title: '3D Map' });
    e.api.addPanel({ id: 'video-0', component: 'video', title: 'Video', position: { referencePanel: 'map3d-0', direction: 'right' } });
    e.api.addPanel({ id: 'graph-0', component: 'graph', title: 'Graph', position: { referencePanel: 'map3d-0', direction: 'below' } });
    e.api.addPanel({ id: 'messages-0', component: 'messages', title: 'Messages', position: { referencePanel: 'video-0', direction: 'below' } });
    e.api.addPanel({ id: 'params-0', component: 'params', title: 'Parameters', position: { referencePanel: 'messages-0', direction: 'within' } });
    e.api.getPanel('messages-0')?.api.setActive();
    e.api.getPanel('graph-0')?.api.setSize({ height: 520 });
  }, []);

  const add = (type: string) => apiRef.current && addWindow(apiRef.current, type);

  return (
    <div className="review">
      <div className="review-toolbar">
        <span className="muted">Add window:</span>
        <button onClick={() => add('map3d')}>3D Map</button>
        <button onClick={() => add('video')}>Video</button>
        <button onClick={() => add('graph')}>Graph</button>
        <button onClick={() => add('messages')}>Messages</button>
        <button onClick={() => add('params')}>Parameters</button>
      </div>
      <div className="dock">
        <DockviewReact
          theme={themeAbyss}
          components={components}
          rightHeaderActionsComponent={HeaderActions}
          onReady={onReady}
          popoutUrl={POPOUT_URL}
        />
      </div>
      <TimelineBar />
    </div>
  );
}

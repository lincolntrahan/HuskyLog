import type { IDockviewPanelProps } from 'dockview-react';

export function PlaceholderPanel({ api }: IDockviewPanelProps) {
  return (
    <div className="hl-panel">
      <div className="placeholder">{api.title} window — arrives in Phase 1</div>
    </div>
  );
}

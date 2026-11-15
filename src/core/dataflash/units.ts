/** Maps DataFlash UNIT labels to short display strings. */
const DISPLAY: Record<string, string> = {
  deg: '°', deglatitude: '°', deglongitude: '°', degheading: '°', degC: '°C',
  'deg/s': '°/s', 'deg/s/s': '°/s²', 'm/s/s': 'm/s²', 'rad/s/s': 'rad/s²',
  UNKNOWN: '', instance: '', satellites: 'sats', percent: '%',
};

export function displayUnit(label: string): string {
  return label in DISPLAY ? DISPLAY[label]! : label;
}

/**
 * printf-style number formatting for overlay readouts (DESIGN §7.7).
 * Supported: %.Nf  %d  %i  %.Ne  %.Ng  %x  %%  with optional width, '+', '0'
 * and ',' (thousands) flags, plus literal text around the spec, e.g.
 * "%.1f", "%+06.2f", "%,d", "Alt %.0f".
 */
const SPEC = /%([+0,-]*)(\d+)?(?:\.(\d+))?([dfiegx%])/g;

export function formatValue(v: number, fmt = '%.2f'): string {
  if (!fmt.includes('%')) fmt = `${fmt} %.2f`.trim();
  return fmt.replace(SPEC, (_m, flags: string, width?: string, prec?: string, conv?: string) => {
    if (conv === '%') return '%';
    if (!Number.isFinite(v)) return Number.isNaN(v) ? '–' : v > 0 ? '∞' : '-∞';
    const p = prec !== undefined ? Number(prec) : undefined;
    let s: string;
    switch (conv) {
      case 'd': case 'i': s = Math.round(v).toString(); break;
      case 'e': s = v.toExponential(p ?? 3); break;
      case 'g': s = Number(v.toPrecision(Math.max(1, p ?? 4))).toString(); break;
      case 'x': s = Math.round(v).toString(16); break;
      default: s = v.toFixed(p ?? 2);
    }
    if (flags.includes(',')) {
      const neg = s.startsWith('-');
      const [int, frac] = (neg ? s.slice(1) : s).split('.');
      s = (neg ? '-' : '') + int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac !== undefined ? `.${frac}` : '');
    }
    if (flags.includes('+') && !s.startsWith('-')) s = `+${s}`;
    const w = width ? Number(width) : 0;
    if (s.length < w) {
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0')) {
        const sign = /^[+-]/.test(s) ? s[0]! : '';
        s = sign + s.slice(sign.length).padStart(w - sign.length, '0');
      } else s = s.padStart(w);
    }
    return s;
  });
}

/** True when the string contains at least one usable conversion. */
export function isValidFormat(fmt: string): boolean {
  SPEC.lastIndex = 0;
  return [...fmt.matchAll(SPEC)].some((m) => m[4] !== '%');
}

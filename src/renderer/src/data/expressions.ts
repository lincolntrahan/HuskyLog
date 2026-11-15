import { create } from 'zustand';
import { evaluate, closest, requirements } from '@core/expr/evaluate';
import { ExprError } from '@core/expr/parser';
import type { Signal } from '@core/expr/evaluate';
import { channelExists, loadChannel, useLogs, type LoadedChannel } from './logs';

/**
 * Named expressions (DESIGN §8), e.g. power = BAT.Volt * BAT.Curr. Usable like
 * channels in any graph or other expression. Phase 6 moves them into the
 * workspace file; until then they persist per machine (browser storage).
 */
const KEY = 'huskylog.namedExpressions.v1';

function loadSaved(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

interface ExprState {
  named: Record<string, string>;
  version: number;
  setNamed: (name: string, src: string) => void;
  removeNamed: (name: string) => void;
  mergeNamed: (defs: Record<string, string>) => void;
}

export const useExpressions = create<ExprState>((set, get) => {
  const persist = (named: Record<string, string>) => {
    try { localStorage.setItem(KEY, JSON.stringify(named)); } catch { /* storage unavailable */ }
  };
  return {
    named: loadSaved(),
    version: 0,
    setNamed: (name, src) => {
      const named = { ...get().named, [name]: src };
      persist(named);
      set({ named, version: get().version + 1 });
    },
    removeNamed: (name) => {
      const named = { ...get().named };
      delete named[name];
      persist(named);
      set({ named, version: get().version + 1 });
    },
    mergeNamed: (defs) => {
      const cur = get().named;
      const add = Object.fromEntries(Object.entries(defs).filter(([k]) => !(k in cur)));
      if (!Object.keys(add).length) return;
      const named = { ...cur, ...add };
      persist(named);
      set({ named, version: get().version + 1 });
    },
  };
});

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED = new Set(['t', 'pi', 'e', 'g']);

export function validateName(name: string, named: Record<string, string>, editing?: string): string | null {
  if (!NAME_RE.test(name)) return 'Names use letters, digits and _ and cannot start with a digit (no dots).';
  if (RESERVED.has(name)) return `"${name}" is reserved.`;
  if (name in named && name !== editing) return `"${name}" already exists.`;
  return null;
}

/** Checks syntax, names and that every channel exists in the stream. */
export function checkExpression(src: string, stream: string, named: Record<string, string>): ExprError | null {
  try {
    const req = requirements(src, named);
    const catalog = useLogs.getState().logs[stream]?.summary?.channels.map((c) => c.id) ?? [];
    for (const id of req.channels) {
      if (!channelExists({ stream, id })) {
        const k = src.indexOf(id);
        const sug = closest(id, catalog);
        return new ExprError(`Channel "${id}" is not in this log.${sug ? ` Did you mean ${sug}?` : ''}`, Math.max(0, k), k >= 0 ? k + id.length : src.length);
      }
    }
    return null;
  } catch (e) {
    return e instanceof ExprError ? e : new ExprError(String(e), 0, src.length);
  }
}

/** Loads the channels an expression needs and evaluates it. */
export async function loadExpression(stream: string, src: string, named: Record<string, string>, unit = ''): Promise<LoadedChannel> {
  const bad = checkExpression(src, stream, named);
  if (bad) throw bad;
  const req = requirements(src, named);
  const channels = new Map<string, Signal>();
  await Promise.all(req.channels.map(async (id) => {
    const c = await loadChannel({ stream, id });
    if (c) channels.set(id, c);
  }));
  const r = evaluate(src, { channels, named });
  return { t: r.t, v: r.v, unit };
}

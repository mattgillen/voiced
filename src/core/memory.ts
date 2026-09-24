// IVR maps: every call teaches Voiced the shape of a phone tree. A screen is a
// run of prompt sentences followed by one agent action. When a later call to
// the same number hears a known screen, the stored action is replayed the
// moment the IVR starts accepting input (barge-in), with no model call.

import { fingerprint } from './parse.js';
import type { Action, MenuOption, TaskKind, TurnKind } from './types.js';

export interface Play {
  action: Action;
  reason: string;
  successes: number;
  failures: number;
}

export interface MapScreen {
  id: string;
  /** Sentence fingerprints, in order. */
  prints: string[];
  /** Example text for display (already scrubbed of secrets). */
  sample: string[];
  title: string;
  kind: TurnKind;
  options: MenuOption[];
  /** Index of the first sentence at which input is accepted. */
  bargeAt: number;
  plays: Partial<Record<TaskKind, Play>>;
  /** Which screen followed this one, per task kind (edges of the tree). */
  next: Partial<Record<TaskKind, string>>;
  seen: number;
}

export interface IvrMap {
  phone: string;
  business: string;
  calls: number;
  screens: MapScreen[];
  updatedAt: number;
}

export interface MapStore {
  load(): Record<string, IvrMap>;
  save(maps: Record<string, IvrMap>): void;
}

export class MemoryStore implements MapStore {
  private maps: Record<string, IvrMap> = {};
  load() {
    return this.maps;
  }
  save(maps: Record<string, IvrMap>) {
    this.maps = maps;
  }
}

const INPUT_CUE = /\b(?:press|enter|say|oprima|key in|tell me|which would you|what (?:day|date|time|name)|how many)\b|\?/i;

/** Digits only, without the North American country code, so "+1 (415) 555-0142" matches "(415) 555-0142". */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export class MapMemory {
  private maps: Record<string, IvrMap>;

  constructor(private store: MapStore = new MemoryStore()) {
    this.maps = store.load() ?? {};
  }

  get(phone: string): IvrMap | undefined {
    return this.maps[phoneKey(phone)];
  }

  all(): IvrMap[] {
    return Object.values(this.maps);
  }

  reset(phone?: string) {
    if (phone) delete this.maps[phoneKey(phone)];
    else this.maps = {};
    this.store.save(this.maps);
  }

  beginCall(phone: string, business: string) {
    const map = this.ensure(phone, business);
    map.calls += 1;
    this.persist(map);
  }

  /**
   * Called for every heard sentence. Returns a replayable play when the
   * sentences heard so far in this turn match a known screen and the IVR is
   * now at (or past) the point where it accepts input.
   */
  lookup(phone: string, kind: TaskKind, heard: string[]): { screen: MapScreen; play: Play } | undefined {
    const map = this.get(phone);
    if (!map || heard.length === 0) return undefined;
    const prints = heard.map(fingerprint);
    for (const screen of map.screens) {
      const play = screen.plays[kind];
      if (!play || play.failures > play.successes) continue;
      if (prints.length - 1 !== screen.bargeAt) continue;
      if (screen.prints.length < prints.length) continue;
      if (prints.every((p, i) => p === screen.prints[i])) return { screen, play };
    }
    return undefined;
  }

  /** Find the screen matching a complete turn (for the UI's "known" badge). */
  match(phone: string, heard: string[]): MapScreen | undefined {
    const map = this.get(phone);
    if (!map || heard.length === 0) return undefined;
    const prints = heard.map(fingerprint);
    return map.screens.find(
      (s) => s.prints.length <= prints.length && s.prints.every((p, i) => p === prints[i]),
    ) ?? map.screens.find((s) => s.prints[0] === prints[0] && s.prints.length === prints.length);
  }

  /** Record what worked on a screen. Returns the screen id. */
  learn(
    phone: string,
    business: string,
    kind: TaskKind,
    heard: string[],
    info: { title: string; kind: TurnKind; options: MenuOption[] },
    action: Action,
    reason: string,
    prevScreenId?: string,
  ): string {
    const map = this.ensure(phone, business);
    const prints = heard.map(fingerprint);
    const id = prints.slice(0, 3).join(' | ');
    let screen = map.screens.find((s) => s.id === id);
    const bargeAt = Math.max(0, heard.findIndex((s) => INPUT_CUE.test(s)));
    if (!screen) {
      screen = {
        id,
        prints,
        sample: heard.slice(0, 6),
        title: info.title,
        kind: info.kind,
        options: info.options,
        bargeAt,
        plays: {},
        next: {},
        seen: 0,
      };
      map.screens.push(screen);
    } else {
      // A longer turn (e.g. a re-prompt) must not shrink what we know about the screen.
      if (prints.length < screen.prints.length) screen.prints = prints;
      screen.bargeAt = Math.min(screen.bargeAt, bargeAt);
    }
    screen.seen += 1;
    const existing = screen.plays[kind];
    if (existing && sameAction(existing.action, action)) existing.successes += 1;
    else screen.plays[kind] = { action, reason, successes: 1, failures: 0 };
    if (prevScreenId) this.link(map, prevScreenId, kind, id);
    this.persist(map);
    return id;
  }

  /** A replayed play worked (the IVR moved on). */
  confirm(phone: string, screenId: string, kind: TaskKind, prevScreenId?: string) {
    const map = this.get(phone);
    const screen = map?.screens.find((s) => s.id === screenId);
    if (!map || !screen) return;
    const play = screen.plays[kind];
    if (play) play.successes += 1;
    screen.seen += 1;
    if (prevScreenId) this.link(map, prevScreenId, kind, screenId);
    this.persist(map);
  }

  /** A replayed play failed (invalid option, menu changed): stop trusting it. */
  fail(phone: string, screenId: string, kind: TaskKind) {
    const map = this.get(phone);
    const play = map?.screens.find((s) => s.id === screenId)?.plays[kind];
    if (!map || !play) return;
    play.failures += 1;
    if (play.failures > play.successes) delete map.screens.find((s) => s.id === screenId)!.plays[kind];
    this.persist(map);
  }

  private link(map: IvrMap, from: string, kind: TaskKind, to: string) {
    const prev = map.screens.find((s) => s.id === from);
    if (prev && prev.id !== to) prev.next[kind] = to;
  }

  private ensure(phone: string, business: string): IvrMap {
    const key = phoneKey(phone);
    this.maps[key] ??= { phone, business, calls: 0, screens: [], updatedAt: 0 };
    return this.maps[key];
  }

  private persist(map: IvrMap) {
    map.updatedAt = Date.now();
    this.store.save(this.maps);
  }
}

function sameAction(a: Action, b: Action): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

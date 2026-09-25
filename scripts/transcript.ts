// Prints call events as a terminal transcript (sim and live calls share it).

import { formatDuration } from '../src/core/session.js';
import type { CallEvent } from '../src/core/types.js';

const clock = (t: number) => formatDuration(t).padStart(7);

export function printEvent(e: CallEvent) {
  switch (e.type) {
    case 'heard':
      if (e.speaker === 'hold' && e.text.startsWith('♪')) return;
      console.log(`${clock(e.t)}  ${e.speaker.toUpperCase().padEnd(5)} ${e.text}`);
      break;
    case 'action':
      if (e.action.type === 'wait' && e.source !== 'map') console.log(`${clock(e.t)}  ·     (${e.reason})`);
      else console.log(`${clock(e.t)}  AGENT ${e.display ? `[${e.action.type}] ${e.display}` : `[${e.action.type}]`}  ← ${e.source}: ${e.reason}`);
      break;
    case 'user_request':
      console.log(`${clock(e.t)}  ⚠︎ ASK ${e.request.title}: ${e.request.detail}`);
      break;
    case 'handoff':
      console.log(`${clock(e.t)}  ⇄ HANDOFF ${e.briefing}`);
      break;
    case 'escalated':
      console.log(`${clock(e.t)}  ⚑ ESCALATED to operator queue (${e.reason} at “${e.step}”): ${e.detail}`);
      break;
    case 'operator':
      console.log(`${clock(e.t)}  ☎ OPERATOR ${e.operator} ${e.state}${e.note ? `: ${e.note}` : ''}`);
      break;
    case 'recording':
      console.log(`${clock(e.t)}  ● recording ${e.paused ? 'paused' : 'resumed'} (${e.reason})`);
      break;
    case 'bridge':
      console.log(`${clock(e.t)}  ${e.from === 'user' ? 'YOU  ' : 'REP  '} ${e.text}`);
      break;
    case 'status':
      if (e.status === 'on_hold') console.log(`${clock(e.t)}  ♪ on hold`);
      break;
  }
}

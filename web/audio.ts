// Optional sound: real DTMF tone pairs for keypresses and the browser's speech
// synthesis for the far end at real-time playback.

export const DTMF: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

let ctx: AudioContext | undefined;

export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = undefined;
  }
}

export function tone(key: string, ms = 110) {
  const pair = DTMF[key];
  if (!ctx || !pair) return;
  const t = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
  gain.gain.setValueAtTime(0.12, t + ms / 1000 - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  gain.connect(ctx.destination);
  for (const f of pair) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + ms / 1000);
  }
}

export function speak(text: string, voice: 'ivr' | 'human' | 'agent') {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text.replace(/♪/g, ''));
    u.rate = voice === 'ivr' ? 1.05 : 1;
    u.pitch = voice === 'agent' ? 1.1 : voice === 'human' ? 1 : 0.9;
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    if (voices.length) u.voice = voices[{ ivr: 0, human: 1, agent: 2 }[voice] % voices.length];
    speechSynthesis.speak(u);
  } catch {
    /* no speech available */
  }
}

export function stopSpeech() {
  try {
    speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

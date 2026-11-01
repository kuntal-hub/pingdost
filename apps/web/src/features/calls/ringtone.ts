// A ring for incoming calls from Web Audio (no audio file): two tones, one second on, two off.
// Browsers may keep audio blocked until the page had a click; the incoming-call dialog shows
// either way.
let context: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function burst(audio: AudioContext): void {
  const gain = audio.createGain();
  gain.gain.value = 0.08;
  gain.connect(audio.destination);
  for (const frequency of [440, 480]) {
    const oscillator = audio.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start();
    oscillator.stop(audio.currentTime + 1);
  }
}

export const ringtone = {
  start(): void {
    if (timer !== undefined || typeof AudioContext === 'undefined') return;
    try {
      context = new AudioContext();
      burst(context);
      timer = setInterval(() => {
        if (context) burst(context);
      }, 3_000);
    } catch {
      context = null;
    }
  },
  stop(): void {
    clearInterval(timer);
    timer = undefined;
    void context?.close().catch(() => undefined);
    context = null;
  },
};

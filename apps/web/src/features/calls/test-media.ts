// Generated media for dev testing (ADR 0028): a quiet tone and a moving picture with the time,
// from Web Audio and a canvas. Used instead of getUserMedia when "Test media" is on (dev
// builds only), so two browsers on one PC can call each other without a camera or prompts.
export function testMediaStream(video: boolean): { stream: MediaStream; stop: () => void } {
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.frequency.value = 440;
  gain.gain.value = 0.02;
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  const stream = new MediaStream(destination.stream.getAudioTracks());

  let timer: ReturnType<typeof setInterval> | undefined;
  if (video) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext('2d');
    let frame = 0;
    timer = setInterval(() => {
      if (!context) return;
      frame++;
      context.fillStyle = `hsl(${(frame * 3) % 360} 60% 40%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      context.font = '24px sans-serif';
      context.fillText(new Date().toLocaleTimeString(), 20, 130);
    }, 66);
    for (const track of canvas.captureStream(15).getVideoTracks()) stream.addTrack(track);
  }

  return {
    stream,
    stop: () => {
      clearInterval(timer);
      oscillator.stop();
      void audio.close();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

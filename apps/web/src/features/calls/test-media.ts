// Generated media for dev testing (ADR 0028): a quiet tone and a moving picture with the time,
// from Web Audio and a canvas. Used instead of getUserMedia (and getDisplayMedia, ADR 0037)
// when "Test media" is on (dev builds only), so two browsers on one PC can call each other
// without a camera, a screen picker or prompts.

/** A moving picture: the label and the time on a shifting colour. */
export function testVideoTrack(label: string): { track: MediaStreamTrack; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext('2d');
  let frame = 0;
  const timer = setInterval(() => {
    if (!context) return;
    frame++;
    context.fillStyle = `hsl(${(frame * 3) % 360} 60% 40%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.font = '24px sans-serif';
    context.fillText(label, 20, 100);
    context.fillText(new Date().toLocaleTimeString(), 20, 140);
  }, 66);
  const track = canvas.captureStream(15).getVideoTracks()[0]!;
  return {
    track,
    stop: () => {
      clearInterval(timer);
      track.stop();
    },
  };
}

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
  const picture = video ? testVideoTrack('Test camera') : undefined;
  if (picture) stream.addTrack(picture.track);
  return {
    stream,
    stop: () => {
      picture?.stop();
      oscillator.stop();
      void audio.close();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

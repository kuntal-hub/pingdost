// Call settings kept in this browser only (localStorage; ADR 0028):
// - "Force relay (TURN)" (debug): every call relays through TURN (`iceTransportPolicy: 'relay'`);
// - "Test media" (dev builds only): a generated tone and picture instead of the microphone
//   and camera, so calls can be tested without devices or permission prompts;
// - the chosen microphone, camera and speaker.
const KEYS = {
  forceRelay: 'pingdost.calls.forceRelay',
  testMedia: 'pingdost.calls.testMedia',
  microphone: 'pingdost.calls.microphone',
  camera: 'pingdost.calls.camera',
  speaker: 'pingdost.calls.speaker',
} as const;

type Key = keyof typeof KEYS;

function read(key: Key): string | null {
  try {
    return localStorage.getItem(KEYS[key]);
  } catch {
    return null;
  }
}

function write(key: Key, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(KEYS[key]);
    else localStorage.setItem(KEYS[key], value);
  } catch {
    // Storage blocked: the setting lasts for this page only.
  }
}

export const callPrefs = {
  forceRelay: (): boolean => read('forceRelay') === '1',
  setForceRelay: (on: boolean) => write('forceRelay', on ? '1' : null),
  testMedia: (): boolean => import.meta.env.DEV && read('testMedia') === '1',
  setTestMedia: (on: boolean) => write('testMedia', on ? '1' : null),
  device: (kind: 'microphone' | 'camera' | 'speaker'): string | null => read(kind),
  setDevice: (kind: 'microphone' | 'camera' | 'speaker', deviceId: string | null) =>
    write(kind, deviceId),
};

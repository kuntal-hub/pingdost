// The call UI over the whole app (ADR 0028): the incoming-call dialog, the in-call screen
// (remote video or the contact's picture, a self view, mute, camera, microphone/camera/speaker
// choice, hang up, "Reconnecting…", the media path) and a short "Call ended" line.
import { Mic, MicOff, Phone, PhoneOff, Settings2, Video, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { contactName, useContact } from '@/chat/contacts';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { CallSnapshot } from '@pingdost/call-engine';

import { callPrefs } from './prefs';
import {
  accept,
  clearEnded,
  decline,
  hangup,
  setCameraOff,
  setMuted,
  switchInput,
  useCalls,
} from './runtime';

const ENDED_TEXT: Record<NonNullable<CallSnapshot['outcome']>, string> = {
  completed: 'Call ended',
  rejected: 'Call declined',
  busy: 'Busy: they are in another call',
  no_answer: 'No answer',
  missed: 'Missed call',
  cancelled: 'Call cancelled',
  failed: 'Call failed',
  answered_elsewhere: 'Answered on another device',
  declined_elsewhere: 'Declined on another device',
};

const ERROR_TEXT: Record<NonNullable<CallSnapshot['error']>, string> = {
  media_denied: 'PingDost may not use the microphone or camera. Allow it in the site settings.',
  media_unavailable: 'No microphone or camera was found.',
  no_devices: 'This contact has no device that can take calls.',
  unreachable: 'Could not reach this contact.',
  connection: 'The connection could not be made or was lost.',
  signaling: 'The call could not be set up. Check your connection.',
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function statusText(call: CallSnapshot, now: number): string {
  switch (call.state) {
    case 'outgoing':
      return 'Calling…';
    case 'ringing':
      return 'Ringing…';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'connected':
      return duration(now - (call.connectedAt ?? now));
    default:
      return '';
  }
}

/** A <video>/<audio> element playing `stream`. */
function Media({
  stream,
  kind,
  muted = false,
  className,
}: {
  stream: MediaStream | null;
  kind: 'video' | 'audio';
  muted?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    const sink = callPrefs.device('speaker');
    const withSink = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    if (!muted && sink && withSink.setSinkId) void withSink.setSinkId(sink).catch(() => undefined);
  }, [stream, muted]);
  // `data-call-media` marks the elements that play sound, for the speaker choice.
  return kind === 'video' ? (
    <video ref={ref} autoPlay playsInline muted={muted} className={className} />
  ) : (
    <audio ref={ref} autoPlay muted={muted} {...(muted ? {} : { 'data-call-media': '' })} />
  );
}

function RoundButton({
  label,
  onClick,
  tone = 'neutral',
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'neutral' | 'danger' | 'accept';
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full',
        tone === 'danger' && 'bg-danger text-white',
        tone === 'accept' && 'bg-success text-white',
        tone === 'neutral' &&
          (pressed ? 'bg-foreground text-background' : 'bg-white/15 text-white hover:bg-white/25'),
      )}
    >
      {children}
    </button>
  );
}

function DevicePicker({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => undefined);
  }, []);
  const canPickSpeaker = 'setSinkId' in HTMLMediaElement.prototype;
  const select = (
    kind: 'microphone' | 'camera' | 'speaker',
    label: string,
    type: MediaDeviceKind,
  ) => {
    const list = devices.filter((d) => d.kind === type && d.deviceId !== '');
    if (list.length === 0) return null;
    return (
      <label className="flex flex-col gap-1 text-sm">
        {label}
        <select
          className="rounded-md border border-border bg-background p-2 text-foreground"
          defaultValue={callPrefs.device(kind) ?? ''}
          onChange={(event) => {
            const id = event.target.value;
            if (kind === 'speaker') {
              callPrefs.setDevice('speaker', id);
              for (const element of document.querySelectorAll<HTMLMediaElement>(
                '[data-call-media]',
              )) {
                const withSink = element as HTMLMediaElement & {
                  setSinkId?: (sink: string) => Promise<void>;
                };
                void withSink.setSinkId?.(id).catch(() => undefined);
              }
            } else {
              void switchInput(kind, id).catch(() => undefined);
            }
          }}
        >
          <option value="">Default</option>
          {list.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <div className="absolute bottom-24 left-1/2 flex w-[min(92vw,22rem)] -translate-x-1/2 flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-xl">
      {select('microphone', 'Microphone', 'audioinput')}
      {select('camera', 'Camera', 'videoinput')}
      {canPickSpeaker && select('speaker', 'Speaker', 'audiooutput')}
      <Button variant="secondary" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}

function Incoming({ call }: { call: CallSnapshot }) {
  const peer = useContact(call.peerUserId);
  const name = contactName(peer);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="incoming-call-title"
      className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(92vw,26rem)] items-center gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-xl"
    >
      <Avatar name={name} url={peer?.avatarUrl} size={48} />
      <div className="min-w-0 flex-1">
        <p id="incoming-call-title" className="truncate font-semibold">
          {name}
        </p>
        <p className="text-sm text-muted">
          {call.video ? 'Incoming video call' : 'Incoming voice call'}
        </p>
      </div>
      <RoundButton label="Decline" tone="danger" onClick={() => void decline()}>
        <PhoneOff aria-hidden />
      </RoundButton>
      <RoundButton label="Answer" tone="accept" onClick={() => void accept()}>
        {call.video ? <Video aria-hidden /> : <Phone aria-hidden />}
      </RoundButton>
    </div>
  );
}

function InCall({ call }: { call: CallSnapshot }) {
  const peer = useContact(call.peerUserId);
  const name = contactName(peer);
  const local = useCalls((state) => state.local);
  const remote = useCalls((state) => state.remote);
  const path = useCalls((state) => state.path);
  const now = useNow(true);
  const [picker, setPicker] = useState(false);
  const showRemoteVideo =
    call.video && !call.remoteCameraOff && (remote?.getVideoTracks().length ?? 0) > 0;
  const showLocalVideo = call.video && !call.cameraOff && (local?.getVideoTracks().length ?? 0) > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${name}`}
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
    >
      {/* The remote audio always plays from here; a <video> below only shows the picture. */}
      <Media stream={remote} kind="audio" />
      <div className="relative min-h-0 flex-1">
        {showRemoteVideo ? (
          <Media stream={remote} kind="video" muted className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <Avatar name={name} url={peer?.avatarUrl} size={112} />
          </div>
        )}
        {showLocalVideo && (
          <Media
            stream={local}
            kind="video"
            muted
            className="absolute right-4 bottom-4 w-32 rounded-md border border-white/30 md:w-48"
          />
        )}
        <div className="absolute inset-x-0 top-0 flex flex-col items-center gap-1 bg-gradient-to-b from-black/70 to-transparent p-4">
          <p className="text-lg font-semibold">{name}</p>
          <p className="text-sm" aria-live="polite">
            {statusText(call, now)}
            {call.remoteMuted && call.state === 'connected' ? ' · their microphone is off' : ''}
          </p>
          {path && call.state === 'connected' && (
            <p className="text-xs text-white/70">
              {path.relayed ? 'Relayed (TURN)' : 'Direct'} · {path.localType}/{path.remoteType} ·{' '}
              {path.protocol}
              {call.relayOnly ? ' · relay forced' : ''} ·{' '}
              {((path.bytesSent + path.bytesReceived) / 1_048_576).toFixed(1)} MB
            </p>
          )}
        </div>
      </div>
      <div className="relative flex items-center justify-center gap-4 p-6">
        <RoundButton
          label={call.muted ? 'Unmute' : 'Mute'}
          pressed={call.muted}
          onClick={() => setMuted(!call.muted)}
        >
          {call.muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
        </RoundButton>
        {call.video && (
          <RoundButton
            label={call.cameraOff ? 'Turn camera on' : 'Turn camera off'}
            pressed={call.cameraOff}
            onClick={() => setCameraOff(!call.cameraOff)}
          >
            {call.cameraOff ? <VideoOff aria-hidden /> : <Video aria-hidden />}
          </RoundButton>
        )}
        <RoundButton label="Audio and video devices" onClick={() => setPicker((open) => !open)}>
          <Settings2 aria-hidden />
        </RoundButton>
        <RoundButton label="Hang up" tone="danger" onClick={() => void hangup()}>
          <PhoneOff aria-hidden />
        </RoundButton>
        {picker && <DevicePicker onClose={() => setPicker(false)} />}
      </div>
    </div>
  );
}

function Ended({ call }: { call: CallSnapshot }) {
  useEffect(() => {
    const timer = setTimeout(clearEnded, call.error ? 6_000 : 3_000);
    return () => clearTimeout(timer);
  }, [call]);
  // Another tab or device took it: nothing to tell.
  if (call.outcome === 'answered_elsewhere' && call.direction === 'in') return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-4 z-50 mx-auto w-[min(92vw,26rem)] rounded-lg border border-border bg-surface p-4 text-foreground shadow-xl"
    >
      <p className="font-semibold">{call.outcome ? ENDED_TEXT[call.outcome] : 'Call ended'}</p>
      {call.error && <p className="text-sm text-muted">{ERROR_TEXT[call.error]}</p>}
      {call.connectedAt !== null && call.endedAt !== null && (
        <p className="text-sm text-muted">{duration(call.endedAt - call.connectedAt)}</p>
      )}
    </div>
  );
}

export function CallOverlay() {
  const call = useCalls((state) => state.call);
  const notice = useCalls((state) => state.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useCalls.setState({ notice: null }), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (notice && !call) {
    return (
      <div
        role="status"
        className="fixed inset-x-0 top-4 z-50 mx-auto w-[min(92vw,26rem)] rounded-lg border border-border bg-surface p-4 text-foreground shadow-xl"
      >
        {notice}
      </div>
    );
  }
  if (!call) return null;
  if (call.state === 'incoming') return <Incoming call={call} />;
  if (call.state === 'ended') return <Ended call={call} />;
  if (call.state === 'idle') return null;
  return <InCall call={call} />;
}

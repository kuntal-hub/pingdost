// The call UI over the app (ADR 0028, 0037): the incoming-call dialog, the in-call screen
// (remote video, a shared screen or the contact's picture, a self view, mute, camera, voice ↔
// video, screen sharing, the next camera, device choice, picture-in-picture, hang up,
// "Reconnecting…", the media path), a minimized call window that leaves the app usable, and a
// short "Call ended" line.
import {
  AppWindow,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  Phone,
  PhoneOff,
  PictureInPicture2,
  ScreenShare,
  ScreenShareOff,
  Settings2,
  SwitchCamera,
  Video,
  VideoOff,
} from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

import { contactName, useContact } from '@/chat/contacts';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { CallSnapshot, ScreenSurface } from '@pingdost/call-engine';

import { callPrefs } from './prefs';
import {
  accept,
  acceptVideo,
  cameraCount,
  cancelVideoRequest,
  clearEnded,
  decline,
  declineVideo,
  flipCamera,
  hangup,
  requestVideo,
  setCameraOff,
  setMinimized,
  setMuted,
  startScreenShare,
  stopScreenShare,
  switchInput,
  switchToVoice,
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

/** How long "They declined video" stays. */
const DECLINED_NOTICE_MS = 4_000;

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

/** The other side's picture is worth showing: their camera in a video call, or their screen. */
function showsRemoteVideo(call: CallSnapshot, remote: MediaStream | null): boolean {
  if ((remote?.getVideoTracks().length ?? 0) === 0) return false;
  return call.remoteScreenSharing || (call.video && !call.remoteCameraOff);
}

/** The remote <video> on screen, for picture-in-picture. */
let remoteVideoElement: HTMLVideoElement | null = null;

async function pictureInPicture(): Promise<void> {
  const element = remoteVideoElement;
  if (!element || !document.pictureInPictureEnabled) return;
  if (document.pictureInPictureElement === element) {
    await document.exitPictureInPicture().catch(() => undefined);
    return;
  }
  await element.requestPictureInPicture().catch(() => undefined);
}

/**
 * The browser may put the call in picture-in-picture by itself when the user switches tabs
 * (Chrome, for video calls): it asks through Media Session.
 */
function useAutoPictureInPicture(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession as MediaSession & {
      setActionHandler(action: string, handler: (() => void) | null): void;
    };
    try {
      session.setActionHandler('enterpictureinpicture', () => void pictureInPicture());
    } catch {
      return; // Not in this browser.
    }
    return () => {
      try {
        session.setActionHandler('enterpictureinpicture', null);
      } catch {
        // Gone already.
      }
    };
  }, [enabled]);
}

/** A <video>/<audio> element playing `stream`. */
function Media({
  stream,
  kind,
  muted = false,
  className,
  remoteVideo = false,
}: {
  stream: MediaStream | null;
  kind: 'video' | 'audio';
  muted?: boolean;
  className?: string;
  /** The other side's picture: picture-in-picture uses it. */
  remoteVideo?: boolean;
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
  useEffect(() => {
    if (!remoteVideo) return;
    const element = ref.current;
    remoteVideoElement = element;
    return () => {
      if (remoteVideoElement === element) remoteVideoElement = null;
    };
  }, [remoteVideo]);
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
  small = false,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'neutral' | 'danger' | 'accept';
  pressed?: boolean;
  small?: boolean;
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
        'flex shrink-0 cursor-pointer items-center justify-center rounded-full',
        small ? 'h-10 w-10' : 'h-14 w-14',
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

/** "What do you want to share?" before the browser's own picker. */
function ShareChooser({ onClose }: { onClose: () => void }) {
  const share = (surface: ScreenSurface) => {
    onClose();
    // Still inside this click: the browser opens its picker only for a user action.
    void startScreenShare(surface);
  };
  return (
    <div
      role="dialog"
      aria-labelledby="share-title"
      className="absolute bottom-24 left-1/2 flex w-[min(92vw,24rem)] -translate-x-1/2 flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-xl"
    >
      <p id="share-title" className="font-semibold">
        What do you want to share?
      </p>
      <Button variant="secondary" className="justify-start" onClick={() => share('app')}>
        <AppWindow aria-hidden /> One window or app
      </Button>
      <Button variant="secondary" className="justify-start" onClick={() => share('screen')}>
        <Monitor aria-hidden /> Your entire screen
      </Button>
      <p className="text-sm text-muted">
        Your browser asks which one next. This PingDost tab is never shared, so your chats stay out
        of it. The picture travels encrypted, straight to your contact.
      </p>
      <Button variant="ghost" onClick={onClose}>
        Cancel
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

/** Requests to switch to video, their answers, and the screen-sharing line. */
function Banners({ call, name, now }: { call: CallSnapshot; name: string; now: number }) {
  const declined = call.videoDeclinedAt !== null && now - call.videoDeclinedAt < DECLINED_NOTICE_MS;
  return (
    <div className="absolute inset-x-0 top-24 flex flex-col items-center gap-2 px-4">
      {call.videoRequest === 'in' && (
        <div
          role="alertdialog"
          aria-labelledby="video-request-title"
          className="flex w-[min(92vw,26rem)] flex-wrap items-center gap-3 rounded-lg bg-surface p-3 text-foreground shadow-xl"
        >
          <Video aria-hidden className="text-accent" />
          <p id="video-request-title" className="min-w-0 flex-1 font-semibold">
            {name} wants to switch to video
          </p>
          <Button variant="ghost" onClick={declineVideo}>
            Not now
          </Button>
          <Button onClick={() => void acceptVideo()}>Switch</Button>
        </div>
      )}
      {call.videoRequest === 'out' && (
        <div
          role="status"
          className="flex w-[min(92vw,26rem)] items-center gap-3 rounded-lg bg-black/60 p-3 text-white"
        >
          <p className="min-w-0 flex-1">Asking {name} to switch to video…</p>
          <Button variant="secondary" onClick={cancelVideoRequest}>
            Cancel
          </Button>
        </div>
      )}
      {declined && (
        <p role="status" className="rounded-lg bg-black/60 px-3 py-2 text-sm text-white">
          {name} stayed on voice
        </p>
      )}
      {call.screenSharing && (
        <div
          role="status"
          className="flex w-[min(92vw,26rem)] items-center gap-3 rounded-lg bg-danger p-3 text-white"
        >
          <ScreenShare aria-hidden />
          <p className="min-w-0 flex-1 font-semibold">You are sharing your screen</p>
          <Button variant="secondary" onClick={() => void stopScreenShare()}>
            Stop
          </Button>
        </div>
      )}
    </div>
  );
}

function InCall({ call }: { call: CallSnapshot }) {
  const peer = useContact(call.peerUserId);
  const name = contactName(peer);
  const local = useCalls((state) => state.local);
  const remote = useCalls((state) => state.remote);
  const path = useCalls((state) => state.path);
  const mirrorSelf = useCalls((state) => state.mirrorSelf);
  const now = useNow(true);
  const [panel, setPanel] = useState<'devices' | 'share' | null>(null);
  const [cameras, setCameras] = useState(0);
  const showRemoteVideo = showsRemoteVideo(call, remote);
  const showLocalVideo =
    (local?.getVideoTracks().length ?? 0) > 0 &&
    ((call.video && !call.cameraOff) || call.videoRequest === 'out');
  const answered = ['connecting', 'connected', 'reconnecting'].includes(call.state);
  const canShare = answered && call.canVideo && 'getDisplayMedia' in (navigator.mediaDevices ?? {});
  const canPip = showRemoteVideo && document.pictureInPictureEnabled;
  useAutoPictureInPicture(showRemoteVideo);
  useEffect(() => {
    if (!call.video) return;
    void cameraCount().then(setCameras);
  }, [call.video, local]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${name}`}
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
    >
      <div className="relative min-h-0 flex-1">
        {showRemoteVideo ? (
          <Media
            stream={remote}
            kind="video"
            muted
            remoteVideo
            className="h-full w-full object-contain"
          />
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
            className={cn(
              'absolute right-4 bottom-4 w-32 rounded-md border border-white/30 md:w-48',
              mirrorSelf && '-scale-x-100',
            )}
          />
        )}
        <div className="absolute inset-x-0 top-0 flex items-start gap-2 bg-gradient-to-b from-black/70 to-transparent p-4">
          <RoundButton small label="Minimize the call" onClick={() => setMinimized(true)}>
            <Minimize2 aria-hidden className="h-5 w-5" />
          </RoundButton>
          <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <p className="truncate text-lg font-semibold">{name}</p>
            <p className="text-sm" aria-live="polite">
              {statusText(call, now)}
              {call.remoteMuted && call.state === 'connected' ? ' · their microphone is off' : ''}
              {call.remoteScreenSharing ? ' · sharing their screen' : ''}
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
          {canPip ? (
            <RoundButton small label="Picture in picture" onClick={() => void pictureInPicture()}>
              <PictureInPicture2 aria-hidden className="h-5 w-5" />
            </RoundButton>
          ) : (
            <span className="w-10" />
          )}
        </div>
        <Banners call={call} name={name} now={now} />
      </div>
      <div className="relative flex flex-wrap items-center justify-center gap-4 p-6">
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
        {call.video && cameras > 1 && (
          <RoundButton label="Next camera" onClick={() => void flipCamera()}>
            <SwitchCamera aria-hidden />
          </RoundButton>
        )}
        {answered &&
          call.canVideo &&
          (call.video ? (
            <RoundButton label="Switch to voice" onClick={switchToVoice}>
              <Phone aria-hidden />
            </RoundButton>
          ) : (
            <RoundButton
              label="Switch to video"
              pressed={call.videoRequest === 'out'}
              onClick={() =>
                call.videoRequest === 'out' ? cancelVideoRequest() : void requestVideo()
              }
            >
              <Video aria-hidden />
            </RoundButton>
          ))}
        {canShare && (
          <RoundButton
            label={call.screenSharing ? 'Stop sharing your screen' : 'Share your screen'}
            pressed={call.screenSharing}
            onClick={() =>
              call.screenSharing
                ? void stopScreenShare()
                : setPanel((open) => (open === 'share' ? null : 'share'))
            }
          >
            {call.screenSharing ? <ScreenShareOff aria-hidden /> : <ScreenShare aria-hidden />}
          </RoundButton>
        )}
        <RoundButton
          label="Audio and video devices"
          onClick={() => setPanel((open) => (open === 'devices' ? null : 'devices'))}
        >
          <Settings2 aria-hidden />
        </RoundButton>
        <RoundButton label="Hang up" tone="danger" onClick={() => void hangup()}>
          <PhoneOff aria-hidden />
        </RoundButton>
        {panel === 'devices' && <DevicePicker onClose={() => setPanel(null)} />}
        {panel === 'share' && <ShareChooser onClose={() => setPanel(null)} />}
      </div>
    </div>
  );
}

/** The call as a small window the user can drag; the rest of the app stays usable. */
function Minimized({ call }: { call: CallSnapshot }) {
  const peer = useContact(call.peerUserId);
  const name = contactName(peer);
  const remote = useCalls((state) => state.remote);
  const now = useNow(true);
  const showRemoteVideo = showsRemoteVideo(call, remote);
  useAutoPictureInPicture(showRemoteVideo);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: offset };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setOffset({
      x: start.from.x + event.clientX - start.x,
      y: start.from.y + event.clientY - start.y,
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const needsAttention = call.videoRequest === 'in';
  return (
    <div
      role="region"
      aria-label={`Call with ${name}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      className={cn(
        'pd-floating fixed top-20 right-4 z-50 flex w-[min(92vw,22rem)] cursor-grab touch-none flex-col overflow-hidden rounded-xl bg-black text-white shadow-2xl active:cursor-grabbing',
        needsAttention && 'ring-4 ring-accent',
      )}
    >
      {showRemoteVideo && (
        <Media stream={remote} kind="video" muted remoteVideo className="aspect-video w-full" />
      )}
      <div className="flex items-center gap-3 p-3">
        {!showRemoteVideo && <Avatar name={name} url={peer?.avatarUrl} size={36} />}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{name}</p>
          <p className="truncate text-xs text-white/80" aria-live="polite">
            {needsAttention ? 'Wants to switch to video' : statusText(call, now)}
            {call.screenSharing ? ' · sharing your screen' : ''}
          </p>
        </div>
        <RoundButton
          small
          label={call.muted ? 'Unmute' : 'Mute'}
          pressed={call.muted}
          onClick={() => setMuted(!call.muted)}
        >
          {call.muted ? (
            <MicOff aria-hidden className="h-5 w-5" />
          ) : (
            <Mic aria-hidden className="h-5 w-5" />
          )}
        </RoundButton>
        <RoundButton small label="Back to the call" onClick={() => setMinimized(false)}>
          <Maximize2 aria-hidden className="h-5 w-5" />
        </RoundButton>
        <RoundButton small label="Hang up" tone="danger" onClick={() => void hangup()}>
          <PhoneOff aria-hidden className="h-5 w-5" />
        </RoundButton>
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

function Notice({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-4 z-[60] mx-auto w-[min(92vw,26rem)] rounded-lg border border-border bg-surface p-4 text-foreground shadow-xl"
    >
      {text}
    </div>
  );
}

export function CallOverlay() {
  const call = useCalls((state) => state.call);
  const notice = useCalls((state) => state.notice);
  const remote = useCalls((state) => state.remote);
  const minimized = useCalls((state) => state.minimized);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useCalls.setState({ notice: null }), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const live = call !== null && !['idle', 'incoming', 'ended'].includes(call.state);
  return (
    <>
      {/* The remote sound plays from here in both views; a <video> only shows the picture. */}
      {live && <Media stream={remote} kind="audio" />}
      {notice && <Notice text={notice} />}
      {call?.state === 'incoming' && <Incoming call={call} />}
      {call?.state === 'ended' && <Ended call={call} />}
      {live && (minimized ? <Minimized call={call} /> : <InCall call={call} />)}
    </>
  );
}

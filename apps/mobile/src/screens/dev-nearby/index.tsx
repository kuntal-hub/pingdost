import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  View,
  type Permission,
} from 'react-native';

import { Toggle as OnOff } from '@/components/controls';
import { Text, TextInput } from '@/components/text';

import {
  addPong,
  BulkReceiver,
  decodeBench,
  emptyPingStats,
  encodeBulkResult,
  encodePing,
  encodeText,
  kbPerSecond,
  sendBulk,
  type PingStats,
} from './bench';
import {
  createBleTransport,
  PingdostNearby,
  type LinkInfo,
  type NearbyNative,
  type NearbyState,
  type ScanMode,
} from '../../../modules/nearby/src';

const SCAN_MODES: ScanMode[] = ['lowLatency', 'balanced', 'lowPower'];
const BULK_PACKET_BYTES = 16 * 1024;
const MB = 1_000_000;

interface LogLine {
  at: number;
  message: string;
}

interface Run {
  linkId: number;
  bytes: number;
  startedAt: number;
  label: string;
}

const time = (at: number) => new Date(at).toTimeString().slice(0, 8);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  quiet?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={`items-center rounded-md px-3 py-2 active:opacity-80 disabled:opacity-40 ${
        props.quiet ? 'border border-border' : 'bg-primary'
      }`}
    >
      <Text className={props.quiet ? 'text-foreground' : 'font-semibold text-on-primary'}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2 rounded-lg border border-border bg-surface p-3">
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      {children}
    </View>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <Text className="text-sm text-foreground">{children}</Text>;
}

function Toggle(props: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View className="flex-row items-center justify-between">
      <Line>{props.label}</Line>
      <OnOff accessibilityLabel={props.label} value={props.value} onValueChange={props.onChange} />
    </View>
  );
}

/** Dev-only proof screen for the Phase 21 nearby spike (ADR 0023). */
export function DevNearby() {
  const native = PingdostNearby;
  if (!native) {
    return (
      <View className="flex-1 bg-background p-4">
        <Line>
          This build has no nearby module. Rebuild the dev client (pnpm --filter @pingdost/mobile
          android).
        </Line>
      </View>
    );
  }
  return <NearbyBench native={native} />;
}

function NearbyBench({ native }: { native: NearbyNative }) {
  const [state, setState] = useState<NearbyState | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const [pings, setPings] = useState<Record<number, PingStats>>({});
  const [autoPing, setAutoPing] = useState<Record<number, boolean>>({});
  const [text, setText] = useState('hello over BLE');
  const [autoConnect, setAutoConnect] = useState(true);
  const [scanMode, setScanMode] = useState<ScanMode>('lowLatency');
  const [fastRotation, setFastRotation] = useState(false);
  const [batteryMark, setBatteryMark] = useState<{ at: number; percent: number } | null>(null);
  const runs = useRef(new Map<number, Run>());
  const pingSeq = useRef(0);
  const startedAt = useRef(0);

  const addLog = useCallback((message: string, at = Date.now()) => {
    setLog((previous) => [{ at, message }, ...previous].slice(0, 250));
  }, []);

  const addResult = useCallback(
    (line: string) => {
      setResults((previous) => [...previous, `${time(Date.now())} ${line}`]);
      addLog(line);
    },
    [addLog],
  );

  const refresh = useCallback(() => {
    native.getState().then(setState, (error: unknown) => addLog(`state: ${errorText(error)}`));
  }, [native, addLog]);

  useEffect(() => {
    const transport = createBleTransport(native);
    const receiver = new BulkReceiver();
    const reply = (linkId: number, packet: Uint8Array) =>
      native
        .send(linkId, packet)
        .catch((error: unknown) => addLog(`link ${linkId}: reply failed (${errorText(error)})`));

    const offPacket = transport.onPacket((data, from) => {
      const packet = decodeBench(data);
      const now = Date.now();
      switch (packet.kind) {
        case 'text':
          addLog(`link ${from.linkId} says: ${packet.text}`);
          break;
        case 'ping':
          void reply(from.linkId, encodePing('pong', packet.seq, packet.sentAt));
          break;
        case 'pong':
          setPings((previous) => ({
            ...previous,
            [from.linkId]: addPong(previous[from.linkId] ?? emptyPingStats, now - packet.sentAt),
          }));
          break;
        case 'bulk':
          receiver.onBulk(packet.runId, packet.size, now);
          break;
        case 'bulkEnd': {
          const result = receiver.onEnd(packet.runId, now);
          if (!result) break;
          addLog(`link ${from.linkId}: received ${result.bytes} B in ${result.receiverMs} ms`);
          void reply(
            from.linkId,
            encodeBulkResult(packet.runId, result.packets, result.bytes, result.receiverMs),
          );
          break;
        }
        case 'bulkResult': {
          const run = runs.current.get(packet.runId);
          if (!run) break;
          runs.current.delete(packet.runId);
          const totalMs = now - run.startedAt;
          addResult(
            `${run.label}: ${packet.bytes} B, ${totalMs} ms end to end = ${kbPerSecond(packet.bytes, totalMs).toFixed(1)} KB/s ` +
              `(receiver ${kbPerSecond(packet.bytes, packet.receiverMs).toFixed(1)} KB/s)`,
          );
          break;
        }
        case 'unknown':
          addLog(`link ${from.linkId}: ${data.length} B of an unknown kind`);
          break;
      }
    });

    const subscriptions = [
      native.addListener('log', (entry) => addLog(entry.message, entry.at)),
      native.addListener('stateChanged', setState),
      native.addListener('peerDiscovered', (peer) => {
        if (peer.first && startedAt.current) {
          addResult(
            `discovered ${peer.address} (RSSI ${peer.rssi}) ${Date.now() - startedAt.current} ms after start`,
          );
        }
      }),
      native.addListener('linkUp', (link) => {
        addResult(
          `link ${link.id} up: ${link.role}, MTU ${link.mtu}, setup ${link.setupMs ?? '?'} ms`,
        );
        refresh();
      }),
      native.addListener('linkDown', (event) => {
        addLog(
          `link ${event.id} down: ${event.reason}${event.unsent ? ` (${event.unsent} unsent)` : ''}`,
        );
        refresh();
      }),
    ];
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      clearInterval(timer);
      offPacket();
      transport.dispose();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [native, addLog, addResult, refresh]);

  // Pings every 2 s on the links that have auto-ping on (range and background checks).
  useEffect(() => {
    const ids = Object.entries(autoPing)
      .filter(([, on]) => on)
      .map(([id]) => Number(id));
    if (ids.length === 0) return;
    const timer = setInterval(() => ids.forEach((id) => ping(id)), 2000);
    return () => clearInterval(timer);
    // `ping` reads only refs, setters and `native`.
  }, [autoPing]);

  function ping(linkId: number) {
    const seq = ++pingSeq.current;
    setPings((previous) => {
      const stats = previous[linkId] ?? emptyPingStats;
      return { ...previous, [linkId]: { ...stats, sent: stats.sent + 1 } };
    });
    native
      .send(linkId, encodePing('ping', seq, Date.now()))
      .catch((error: unknown) => addLog(`link ${linkId}: ping not sent (${errorText(error)})`));
  }

  async function requestPermissions() {
    if (Platform.OS !== 'android') return;
    const sdk = Number(Platform.Version);
    const all = PermissionsAndroid.PERMISSIONS;
    const wanted: Permission[] =
      sdk >= 31
        ? [all.BLUETOOTH_SCAN, all.BLUETOOTH_ADVERTISE, all.BLUETOOTH_CONNECT]
        : [all.ACCESS_FINE_LOCATION];
    if (sdk >= 33) wanted.push(all.POST_NOTIFICATIONS);
    const granted = await PermissionsAndroid.requestMultiple(wanted);
    addLog(
      `permissions: ${Object.entries(granted)
        .map(([name, result]) => `${name.split('.').pop()} ${result}`)
        .join(', ')}`,
    );
    refresh();
  }

  async function call(label: string, action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      addLog(`${label} failed: ${errorText(error)}`);
    }
    refresh();
  }

  async function start() {
    startedAt.current = Date.now();
    await call('start', () =>
      native.start({ autoConnect, scanMode, rotationSeconds: fastRotation ? 60 : 600 }),
    );
  }

  async function runBulk(link: LinkInfo, bytes: number) {
    const runId = (Math.random() * 0xffffffff) >>> 0;
    const label = `${bytes / MB} MB on link ${link.id} (MTU ${link.mtu}, PHY ${link.txPhy}/${link.rxPhy})`;
    runs.current.set(runId, { linkId: link.id, bytes, startedAt: Date.now(), label });
    addLog(`${label}: sending`);
    try {
      const sent = await sendBulk(
        (packet) => native.send(link.id, packet),
        runId,
        bytes,
        BULK_PACKET_BYTES,
      );
      addLog(
        `${label}: all ${sent.packets} packets queued after ${Date.now() - runs.current.get(runId)!.startedAt} ms`,
      );
    } catch (error) {
      runs.current.delete(runId);
      addLog(`${label}: stopped (${errorText(error)})`);
    }
  }

  function sendText() {
    const packet = encodeText(text);
    for (const link of state?.links ?? []) {
      if (link.up) void call(`text on link ${link.id}`, () => native.send(link.id, packet));
    }
  }

  function report(): string {
    const power = state?.power;
    const battery =
      batteryMark && power
        ? `battery ${batteryMark.percent}% → ${power.batteryPercent}% over ${Math.round((Date.now() - batteryMark.at) / 60000)} min`
        : 'battery: not marked';
    const pingLines = Object.entries(pings).map(
      ([id, s]) =>
        `ping link ${id}: ${s.received}/${s.sent} answered, min ${s.minMs ?? '-'} avg ${
          s.received ? Math.round(s.totalMs / s.received) : '-'
        } max ${s.maxMs ?? '-'} ms`,
    );
    return [
      `PingDost nearby spike — ${state?.device ?? '?'}, Android SDK ${state?.sdk ?? '?'}`,
      `2M PHY ${state?.le2MPhy}, extended adverts ${state?.extendedAdvertising}, FGS ${state?.foregroundService}`,
      battery,
      ...results,
      ...pingLines,
    ].join('\n');
  }

  const power = state?.power;
  const links = state?.links ?? [];
  const peers = state?.peers ?? [];

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-3 p-3">
      <Section title="This phone">
        {state ? (
          <>
            <Line>
              {state.device} · SDK {state.sdk} ·{' '}
              {state.supported ? 'supported' : `unsupported (${state.unsupportedReason})`}
            </Line>
            <Line>
              Bluetooth {state.enabled ? 'on' : 'OFF'} · missing permissions:{' '}
              {state.missingPermissions.length ? state.missingPermissions.join(', ') : 'none'}
            </Line>
            <Line>
              {state.running ? 'running' : 'stopped'} · advertising {String(state.advertising)} ·
              scanning {String(state.scanning)} · token {state.token.slice(0, 8)}… (
              {state.rotationSeconds} s)
            </Line>
            <Line>
              2M PHY {String(state.le2MPhy)} · extended adverts {String(state.extendedAdvertising)}{' '}
              · foreground service {String(state.foregroundService)} · inbound queue{' '}
              {state.inboundQueued}
            </Line>
            {power && (
              <Line>
                battery {power.batteryPercent}%{power.charging ? ' charging' : ''} · saver{' '}
                {String(power.powerSave)} · Doze {String(power.deviceIdle)} · unrestricted{' '}
                {String(power.ignoringBatteryOptimizations)} · screen{' '}
                {power.interactive ? 'on' : 'off'} · importance {power.importance}
              </Line>
            )}
          </>
        ) : (
          <Line>Loading…</Line>
        )}
        <View className="flex-row flex-wrap gap-2">
          <Button label="Permissions" onPress={() => void requestPermissions()} quiet />
          <Button label="Start" onPress={() => void start()} />
          <Button label="Stop" onPress={() => void call('stop', () => native.stop())} quiet />
          <Button
            label="Rotate token"
            onPress={() => void call('rotate', () => native.rotateToken())}
            quiet
          />
        </View>
        <Toggle
          label="Auto-connect (lower token connects)"
          value={autoConnect}
          onChange={setAutoConnect}
        />
        <Toggle
          label="Rotate the token every 60 s (else 10 min)"
          value={fastRotation}
          onChange={setFastRotation}
        />
        <View className="flex-row items-center justify-between">
          <Line>Scan mode: {scanMode}</Line>
          <Button
            label="Next mode"
            quiet
            onPress={() =>
              setScanMode(SCAN_MODES[(SCAN_MODES.indexOf(scanMode) + 1) % SCAN_MODES.length]!)
            }
          />
        </View>
        <Line>Options apply on the next Start.</Line>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={
              state?.foregroundService ? 'Stop foreground service' : 'Start foreground service'
            }
            quiet
            onPress={() =>
              void call('foreground service', () =>
                state?.foregroundService
                  ? native.stopForegroundService()
                  : native.startForegroundService(),
              )
            }
          />
          <Button
            label="Mark battery"
            quiet
            disabled={!power}
            onPress={() =>
              power && setBatteryMark({ at: Date.now(), percent: power.batteryPercent })
            }
          />
        </View>
        {batteryMark && power && (
          <Line>
            Battery since mark: {batteryMark.percent}% → {power.batteryPercent}% in{' '}
            {Math.round((Date.now() - batteryMark.at) / 60000)} min
          </Line>
        )}
      </Section>

      <Section title={`Peers (${peers.length})`}>
        {peers.length === 0 && <Line>None yet. Start on both phones.</Line>}
        {peers.map((peer) => (
          <View key={peer.address} className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-sm text-foreground">
              {peer.address} · token {peer.token?.slice(0, 8) ?? '?'} · RSSI {peer.rssi} · seen{' '}
              {Math.round(peer.seenAgoMs / 1000)} s ago{peer.linked ? ' · linked' : ''}
            </Text>
            <Button
              label="Connect"
              quiet
              disabled={peer.linked}
              onPress={() =>
                void call(`connect ${peer.address}`, () => native.connect(peer.address))
              }
            />
          </View>
        ))}
      </Section>

      <Section title={`Links (${links.length})`}>
        {links.map((link) => {
          const stats = pings[link.id];
          return (
            <View key={link.id} className="gap-2 border-t border-border pt-2">
              <Line>
                #{link.id} {link.role} {link.address} · {link.up ? 'up' : 'setting up'} · MTU{' '}
                {link.mtu} · PHY {link.txPhy}/{link.rxPhy} · setup {link.setupMs ?? '?'} ms
              </Line>
              <Line>
                sent {link.packetsSent} pk / {link.bytesSent} B · received {link.packetsReceived} pk
                / {link.bytesReceived} B · queued {link.unsent} · credits {link.sendCredits}
              </Line>
              {stats && (
                <Line>
                  ping {stats.received}/{stats.sent} · last {stats.lastMs ?? '-'} ms · avg{' '}
                  {stats.received ? Math.round(stats.totalMs / stats.received) : '-'} ms
                </Line>
              )}
              <View className="flex-row flex-wrap gap-2">
                <Button label="Ping" quiet disabled={!link.up} onPress={() => ping(link.id)} />
                <Button
                  label="1 MB"
                  quiet
                  disabled={!link.up}
                  onPress={() => void runBulk(link, MB)}
                />
                <Button
                  label="10 MB"
                  quiet
                  disabled={!link.up}
                  onPress={() => void runBulk(link, 10 * MB)}
                />
                <Button
                  label="Disconnect"
                  quiet
                  onPress={() =>
                    void call(`disconnect ${link.id}`, () => native.disconnect(link.id))
                  }
                />
              </View>
              <Toggle
                label="Auto-ping every 2 s"
                value={autoPing[link.id] ?? false}
                onChange={(on) => setAutoPing((previous) => ({ ...previous, [link.id]: on }))}
              />
            </View>
          );
        })}
        <TextInput
          value={text}
          onChangeText={setText}
          className="rounded-md border border-border p-2 text-foreground"
          placeholder="Text to send"
        />
        <Button
          label="Send text to every link"
          disabled={!links.some((l) => l.up)}
          onPress={sendText}
        />
      </Section>

      <Section title="Results">
        {results.length === 0 && (
          <Line>Discovery, link setup and throughput results appear here.</Line>
        )}
        {results.map((line, index) => (
          <Line key={index}>{line}</Line>
        ))}
        <View className="flex-row gap-2">
          <Button label="Share report" onPress={() => void Share.share({ message: report() })} />
          <Button label="Clear" quiet onPress={() => setResults([])} />
        </View>
      </Section>

      <Section title="Link log">
        {log.map((line, index) => (
          <Text key={`${line.at}-${index}`} className="text-xs text-muted">
            {time(line.at)} {line.message}
          </Text>
        ))}
      </Section>
    </ScrollView>
  );
}

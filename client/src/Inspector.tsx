
import { useEffect, useRef, useState } from 'react';

type Snapshot = {
  relayed: boolean;
  localType: string;
  remoteType: string;
  protocol: string;
  rttMs: number | null;
  downKbps: number | null;
  upKbps: number | null;
  lossPct: number | null;
  fps: number | null;
  resolution: string | null;
};

// Shows what is actually happening under the call, using the browser's
// RTCPeerConnection.getStats(). Polls once per second while connected.
export function Inspector({ pc, active }: { pc: RTCPeerConnection | null; active: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const prev = useRef<{ t: number; rx: number; tx: number } | null>(null);

  useEffect(() => {
    if (!pc || !active) {
      setSnap(null);
      prev.current = null;
      return;
    }
    const conn = pc;
    let stopped = false;

    async function poll() {
      try {
        const report = await conn.getStats();
        if (stopped) return;

        const byId = new Map<string, any>();
        report.forEach((r) => byId.set(r.id, r));

        // 1. Find the candidate pair the call is really using.
        let pair: any = null;
        byId.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            pair = byId.get(r.selectedCandidatePairId) ?? pair;
          }
        });
        if (!pair) {
          // Fallback for browsers that don't expose the selected pair on 'transport'.
          byId.forEach((r) => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
          });
        }
        if (!pair) return;

        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        const localType: string = local?.candidateType ?? '?';
        const remoteType: string = remote?.candidateType ?? '?';
        const relayed = localType === 'relay' || remoteType === 'relay';

        // 2. Add up the video traffic in each direction.
        let rxBytes = 0;
        let txBytes = 0;
        let lost = 0;
        let received = 0;
        let fps: number | null = null;
        let resolution: string | null = null;
        byId.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            rxBytes += r.bytesReceived ?? 0;
            lost += r.packetsLost ?? 0;
            received += r.packetsReceived ?? 0;
            if (r.framesPerSecond != null) fps = Math.round(r.framesPerSecond);
            if (r.frameWidth) resolution = `${r.frameWidth}x${r.frameHeight}`;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            txBytes += r.bytesSent ?? 0;
          }
        });

        // 3. Turn byte counters into kilobits per second.
        const now = Date.now();
        let downKbps: number | null = null;
        let upKbps: number | null = null;
        const p = prev.current;
        if (p && now > p.t && rxBytes >= p.rx && txBytes >= p.tx) {
          const secs = (now - p.t) / 1000;
          downKbps = Math.round(((rxBytes - p.rx) * 8) / secs / 1000);
          upKbps = Math.round(((txBytes - p.tx) * 8) / secs / 1000);
        }
        prev.current = { t: now, rx: rxBytes, tx: txBytes };

        const totalPackets = lost + received;
        setSnap({
          relayed,
          localType,
          remoteType,
          protocol: (local?.protocol ?? '?').toUpperCase(),
          rttMs:
            typeof pair.currentRoundTripTime === 'number'
              ? Math.round(pair.currentRoundTripTime * 1000)
              : null,
          downKbps,
          upKbps,
          lossPct: totalPackets > 0 ? Math.round((lost / totalPackets) * 1000) / 10 : 0,
          fps,
          resolution,
        });
      } catch (err) {
        console.warn('getStats failed', err);
      }
    }

    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pc, active]);

  if (!snap) return null;

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className={`route ${snap.relayed ? 'route-relay' : 'route-direct'}`}>
          {snap.relayed ? 'Relayed through TURN' : 'Direct peer-to-peer'}
        </span>
        <span className="inspector-hint">
          {snap.relayed
            ? 'A TURN server is forwarding the media because a direct path was blocked.'
            : 'Video flows straight between the two devices.'}
        </span>
      </div>
      <div className="inspector-grid">
        <div>
          <b>{snap.rttMs ?? '-'}</b> ms
          <small>round trip</small>
        </div>
        <div>
          <b>{snap.downKbps ?? '-'}</b> kbps
          <small>download</small>
        </div>
        <div>
          <b>{snap.upKbps ?? '-'}</b> kbps
          <small>upload</small>
        </div>
        <div>
          <b>{snap.lossPct ?? '-'}</b> %
          <small>packet loss</small>
        </div>
        <div>
          <b>{snap.fps ?? '-'}</b> fps
          <small>{snap.resolution ?? 'video'}</small>
        </div>
        <div>
          <b>{snap.protocol}</b>
          <small>
            {snap.localType} to {snap.remoteType}
          </small>
        </div>
      </div>
    </div>
  );
}
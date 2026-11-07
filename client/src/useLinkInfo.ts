/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';

export type LinkInfo = { rttMs: number | null; relayed: boolean | null };

// Reads the round-trip time and whether the call is relayed, for the chat header.
export function useLinkInfo(pc: RTCPeerConnection | null, active: boolean): LinkInfo {
  const [info, setInfo] = useState<LinkInfo>({ rttMs: null, relayed: null });

  useEffect(() => {
    if (!pc || !active) {
      setInfo({ rttMs: null, relayed: null });
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
        let pair: any = null;
        byId.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            pair = byId.get(r.selectedCandidatePairId) ?? pair;
          }
        });
        if (!pair) {
          byId.forEach((r) => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
          });
        }
        if (!pair) return;
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        setInfo({
          rttMs:
            typeof pair.currentRoundTripTime === 'number'
              ? Math.round(pair.currentRoundTripTime * 1000)
              : null,
          relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
        });
      } catch {
        // Stats are a nicety here; ignore a failed read.
      }
    }

    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pc, active]);

  return info;
}
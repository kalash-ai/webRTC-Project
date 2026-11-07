/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react';

export type Quality = 'good' | 'fair' | 'poor';

// Limits applied to the video WE send, based on how the other side reports receiving it.
const LIMITS: Record<Quality, { maxBitrate: number; scaleDown: number; maxFps: number }> = {
  good: { maxBitrate: 2_500_000, scaleDown: 1, maxFps: 30 },
  fair: { maxBitrate: 800_000, scaleDown: 1.5, maxFps: 24 },
  poor: { maxBitrate: 250_000, scaleDown: 2.5, maxFps: 15 },
};

const POLL_MS = 2000;
const DOWN_AFTER = 2; // polls in a worse state before lowering quality
const UP_AFTER = 4; // polls in a better state before raising it one step

function rank(q: Quality): number {
  return q === 'good' ? 0 : q === 'fair' ? 1 : 2;
}

function classify(lossPct: number, rttMs: number | null): Quality {
  const rtt = rttMs ?? 0;
  if (lossPct >= 8 || rtt >= 600) return 'poor';
  if (lossPct >= 3 || rtt >= 300) return 'fair';
  return 'good';
}

export function useAdaptiveQuality(pc: RTCPeerConnection | null, active: boolean): Quality | null {
  const [quality, setQuality] = useState<Quality | null>(null);
  const current = useRef<Quality>('good');
  const worseCount = useRef(0);
  const betterCount = useRef(0);

  useEffect(() => {
    current.current = 'good';
    worseCount.current = 0;
    betterCount.current = 0;
    if (!pc || !active) {
      setQuality(null);
      return;
    }
    setQuality('good');
    const conn = pc;
    let stopped = false;
    // Test switch: open the site with ?simulate=fair or ?simulate=poor
    const simulate = new URLSearchParams(window.location.search).get('simulate');

    async function apply(q: Quality) {
      const sender = conn.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        const limits = LIMITS[q];
        params.encodings[0].maxBitrate = limits.maxBitrate;
        params.encodings[0].scaleResolutionDownBy = limits.scaleDown;
        params.encodings[0].maxFramerate = limits.maxFps;
        await sender.setParameters(params);
      } catch (err) {
        console.warn('Could not change video quality', err);
      }
    }

    async function poll() {
      let measured: Quality;
      if (simulate === 'fair' || simulate === 'poor') {
        measured = simulate;
      } else {
        const report = await conn.getStats();
        if (stopped) return;
        let fractionLost = 0;
        let rtt: number | null = null;
        report.forEach((r: any) => {
          if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
            if (typeof r.fractionLost === 'number') fractionLost = r.fractionLost;
            if (typeof r.roundTripTime === 'number') rtt = r.roundTripTime * 1000;
          }
        });
        measured = classify(fractionLost * 100, rtt);
      }

      // Hysteresis: go down quickly, come back up slowly, one step at a time.
      const cur = current.current;
      const diff = rank(measured) - rank(cur);
      let next: Quality | null = null;
      if (diff > 0) {
        worseCount.current += 1;
        betterCount.current = 0;
        if (worseCount.current >= DOWN_AFTER) next = measured;
      } else if (diff < 0) {
        betterCount.current += 1;
        worseCount.current = 0;
        if (betterCount.current >= UP_AFTER) next = cur === 'poor' ? 'fair' : 'good';
      } else {
        worseCount.current = 0;
        betterCount.current = 0;
      }
      if (next && !stopped) {
        current.current = next;
        worseCount.current = 0;
        betterCount.current = 0;
        setQuality(next);
        await apply(next);
      }
    }

    const timer = setInterval(() => {
      poll().catch(console.error);
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pc, active]);

  return quality;
}
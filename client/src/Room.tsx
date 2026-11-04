/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react';
import { Inspector } from './Inspector';
import {
  ActivityIcon,
  CameraIcon,
  CameraOffIcon,
  ClockIcon,
  LinkIcon,
  LockIcon,
  MaximizeIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  VideoIcon,
} from './icons';

const SIGNALING_URL: string = import.meta.env.VITE_SIGNALING_URL ?? 'ws://localhost:8080';

type Status =
  | 'starting'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'full'
  | 'denied'
  | 'error';

const STATUS_TEXT: Record<Status, string> = {
  starting: 'Starting camera...',
  waiting: 'Waiting for the other person',
  connecting: 'Connecting...',
  connected: 'Connected',
  failed: 'Connection failed',
  full: 'This room is full (2 people max)',
  denied: 'Camera or microphone unavailable',
  error: 'Something went wrong',
};

// mm:ss counter that runs while the call is connected.
function useCallTimer(running: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// True while the other person's audio is loud enough to count as talking.
function useSpeaking(stream: MediaStream | null): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream) {
      setSpeaking(false);
      return;
    }
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let lastLoud = 0;
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      if (Math.sqrt(sum / data.length) > 0.03) lastLoud = Date.now();
      setSpeaking(Date.now() - lastLoud < 600);
    }, 200);
    return () => {
      clearInterval(timer);
      source.disconnect();
      ctx.close();
      setSpeaking(false);
    };
  }, [stream]);
  return speaking;
}

export function Room({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const roomRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<Status>('starting');
  const [errorText, setErrorText] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [statsPc, setStatsPc] = useState<RTCPeerConnection | null>(null);
  const [remoteAudio, setRemoteAudio] = useState<MediaStream | null>(null);
  const [showStats, setShowStats] = useState(false);

  const timer = useCallTimer(status === 'connected');
  const speaking = useSpeaking(remoteAudio);

  useEffect(() => {
    // Everything lives inside this effect so React StrictMode's
    // mount -> cleanup -> mount cycle cannot leave sockets or cameras behind.
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pc: RTCPeerConnection | null = null;
    let stream: MediaStream | null = null;
    let iceServers: RTCIceServer[] = [];
    let pendingCandidates: RTCIceCandidateInit[] = [];
    let remoteDescriptionSet = false;
    let offerWhenReady = false;
    // Messages are handled one at a time, in order, so awaits can't race.
    let queue: Promise<void> = Promise.resolve();

    function send(payload: object) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    }

    function createPeerConnection() {
      pc?.close();
   const forceRelay = new URLSearchParams(window.location.search).get('relay') === '1';
const conn = new RTCPeerConnection({
  iceServers,
  iceTransportPolicy: forceRelay ? 'relay' : 'all',
});
      pc = conn;
      setStatsPc(conn);
      remoteDescriptionSet = false;
      pendingCandidates = [];

      stream?.getTracks().forEach((track) => conn.addTrack(track, stream!));

      conn.onicecandidate = (e) => {
        if (pc === conn && e.candidate) {
          send({ type: 'iceCandidate', candidate: e.candidate });
        }
      };
      conn.ontrack = (e) => {
        if (pc !== conn) return;
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
        if (e.track.kind === 'audio') setRemoteAudio(new MediaStream([e.track]));
      };
      conn.onconnectionstatechange = () => {
        if (pc !== conn || cancelled) return;
        if (conn.connectionState === 'connected') setStatus('connected');
        else if (conn.connectionState === 'failed') setStatus('failed');
        else if (conn.connectionState === 'disconnected') setStatus('connecting');
      };
    }

    async function makeOffer() {
      if (!pc) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'createOffer', sdp: pc.localDescription });
    }

    async function flushCandidates() {
      const toAdd = pendingCandidates;
      pendingCandidates = [];
      for (const candidate of toAdd) {
        try {
          await pc?.addIceCandidate(candidate);
        } catch (err) {
          console.warn('addIceCandidate failed', err);
        }
      }
    }

    async function handle(message: any) {
      if (cancelled) return;
      switch (message.type) {
        case 'joined': {
          iceServers = message.iceServers ?? [];
          createPeerConnection();
          setStatus(message.peerPresent ? 'connecting' : 'waiting');
          if (offerWhenReady) {
            offerWhenReady = false;
            setStatus('connecting');
            await makeOffer();
          }
          break;
        }
        case 'peerJoined': {
          // We were here first, so we start the call by sending the offer.
          setStatus('connecting');
          if (pc) await makeOffer();
          else offerWhenReady = true;
          break;
        }
        case 'createOffer': {
          if (!pc) return;
          await pc.setRemoteDescription(message.sdp);
          remoteDescriptionSet = true;
          await flushCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: 'createAnswer', sdp: pc.localDescription });
          break;
        }
        case 'createAnswer': {
          if (!pc) return;
          await pc.setRemoteDescription(message.sdp);
          remoteDescriptionSet = true;
          await flushCandidates();
          break;
        }
        case 'iceCandidate': {
          if (!pc) return;
          if (remoteDescriptionSet) {
            try {
              await pc.addIceCandidate(message.candidate);
            } catch (err) {
              console.warn('addIceCandidate failed', err);
            }
          } else {
            // Arrived before the offer/answer: hold it until we can use it.
            pendingCandidates.push(message.candidate);
          }
          break;
        }
        case 'peerLeft': {
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          setRemoteAudio(null);
          createPeerConnection(); // fresh connection, ready for the next person
          setStatus('waiting');
          break;
        }
        case 'roomFull': {
          setStatus('full');
          break;
        }
        case 'error': {
          console.warn('Server error:', message.message);
          break;
        }
      }
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (err: any) {
        if (cancelled) return;
        if (!navigator.mediaDevices) {
          setErrorText('Camera access needs HTTPS (or localhost).');
        } else if (err?.name === 'NotAllowedError') {
          setErrorText('Permission denied. Allow camera and microphone in your browser, then reload.');
        } else if (err?.name === 'NotFoundError') {
          setErrorText('No camera or microphone was found on this device.');
        } else {
          setErrorText('Could not start your camera or microphone.');
        }
        setStatus('denied');
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      ws = new WebSocket(SIGNALING_URL);
      ws.onopen = () => send({ type: 'join', roomId });
      ws.onmessage = (ev) => {
        let message: any;
        try {
          message = JSON.parse(ev.data);
        } catch {
          return;
        }
        queue = queue.then(() => handle(message)).catch(console.error);
      };
      ws.onerror = () => {
        if (cancelled) return;
        setErrorText('Could not reach the signaling server.');
        setStatus('error');
      };
      ws.onclose = () => {
        if (cancelled) return;
        setErrorText((prev) => prev || 'Lost connection to the server.');
        setStatus((prev) => (prev === 'full' || prev === 'denied' ? prev : 'error'));
      };
    }

    start();

    return () => {
      cancelled = true;
      send({ type: 'leave' });
      ws?.close();
      pc?.close();
      stream?.getTracks().forEach((t) => t.stop());
      pc = null;
      ws = null;
      stream = null;
      localStreamRef.current = null;
      setStatsPc(null);
    };
  }, [roomId]);

  function toggleTrack(kind: 'audio' | 'video') {
    const stream = localStreamRef.current;
    if (!stream) return;
    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    if (tracks.length === 0) return;
    const next = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = next));
    if (kind === 'audio') setMicOn(next);
    else setCamOn(next);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the link is also shown on screen to copy by hand.
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else roomRef.current?.requestFullscreen();
  }

  const controlsDisabled = status === 'denied' || status === 'full' || status === 'error';
  const failedHint = 'A strict network or firewall may be blocking the call.';

  return (
    <div className="room" ref={roomRef}>
      <div className="stage">
        <video ref={remoteVideoRef} className="remote" autoPlay playsInline />

        <div className="top-left">
          <span className={`pill pill-status is-${status}`}>
            <span className="dot" />
            {STATUS_TEXT[status]}
          </span>
          {status === 'connected' && (
            <span className="pill pill-timer">
              <ClockIcon size={16} />
              {timer}
            </span>
          )}
        </div>

        {document.fullscreenEnabled && (
          <button className="fs-btn" onClick={toggleFullscreen} aria-label="Toggle fullscreen">
            <MaximizeIcon size={20} />
          </button>
        )}

        {status !== 'connected' && (
          <div className="overlay">
            {status === 'waiting' ? (
              <>
                <div className="overlay-icon">
                  <VideoIcon size={28} />
                </div>
                <p className="overlay-title">Waiting for someone to join</p>
                <p className="overlay-sub">Share this link with one other person</p>
                <div className="share-row">
                  <LinkIcon size={18} />
                  <code>{window.location.href}</code>
                  <button className="btn-secondary small" onClick={copyLink}>
                    {copied ? 'Copied!' : 'Copy link'}
                  </button>
                </div>
              </>
            ) : status === 'starting' || status === 'connecting' ? (
              <>
                <div className="spinner" />
                <p className="overlay-title">{STATUS_TEXT[status]}</p>
              </>
            ) : (
              <>
                <p className="overlay-title">{STATUS_TEXT[status]}</p>
                <p className="overlay-sub">{status === 'failed' ? failedHint : errorText}</p>
                <button className="btn-primary small" onClick={onLeave}>
                  Back to home
                </button>
              </>
            )}
          </div>
        )}

        {status === 'connected' && (
          <div className="remote-label">
            <div className="remote-name">Guest</div>
            {speaking && (
              <div className="speaking">
                <span className="bars">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                Speaking
              </div>
            )}
          </div>
        )}

        <div className="pip">
          {/* Local preview is muted so you never hear your own voice echo. */}
          <video ref={localVideoRef} autoPlay playsInline muted />
          {!camOn && (
            <div className="pip-off">
              <CameraOffIcon size={26} />
            </div>
          )}
          <span className="pip-label">You</span>
        </div>

        {showStats && (
          <div className="stats-panel">
            <Inspector pc={statsPc} active={status === 'connected'} />
          </div>
        )}
      </div>

      <div className="controls">
        <button
          className={`ctl ${micOn ? '' : 'is-off'}`}
          onClick={() => toggleTrack('audio')}
          disabled={controlsDisabled}
        >
          <span className="ctl-icon">{micOn ? <MicIcon size={24} /> : <MicOffIcon size={24} />}</span>
          <span className="ctl-label">{micOn ? 'Mute' : 'Unmute'}</span>
        </button>
        <button
          className={`ctl ${camOn ? '' : 'is-off'}`}
          onClick={() => toggleTrack('video')}
          disabled={controlsDisabled}
        >
          <span className="ctl-icon">
            {camOn ? <CameraIcon size={24} /> : <CameraOffIcon size={24} />}
          </span>
          <span className="ctl-label">Camera</span>
        </button>
        <button
          className={`ctl ${showStats ? 'is-on' : ''}`}
          onClick={() => setShowStats((v) => !v)}
          disabled={status !== 'connected'}
        >
          <span className="ctl-icon">
            <ActivityIcon size={24} />
          </span>
          <span className="ctl-label">Stats</span>
        </button>
        <button className="ctl ctl-leave" onClick={onLeave}>
          <span className="ctl-icon">
            <PhoneOffIcon size={24} />
          </span>
          <span className="ctl-label">Leave Call</span>
        </button>
      </div>

      <div className="room-foot">
        <LockIcon size={16} />
        Encrypted peer connection
      </div>
    </div>
  );
}
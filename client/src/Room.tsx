import { useEffect, useRef, useState } from 'react';
import { Inspector } from './Inspector';
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

export function Room({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<Status>('starting');
  const [errorText, setErrorText] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [statsPc, setStatsPc] = useState<RTCPeerConnection | null>(null);

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
      const conn = new RTCPeerConnection({ iceServers });
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
        if (pc === conn && remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = e.streams[0];
        }
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

  const controlsDisabled = status === 'denied' || status === 'full' || status === 'error';

  return (
    <div className="room">
      <div className="topbar">
        <span className={`badge badge-${status}`}>{STATUS_TEXT[status]}</span>
        {errorText && <span className="error-text">{errorText}</span>}
      </div>

      <div className="videos">
        <video ref={remoteVideoRef} className="remote" autoPlay playsInline />
        {/* Local preview is muted so you never hear your own voice echo. */}
        <video ref={localVideoRef} className="local" autoPlay playsInline muted />
      </div>
  <Inspector pc={statsPc} active={status === 'connected'} />
      {status === 'waiting' && (
        <div className="share">
          <p>Share this link with one other person:</p>
          <code>{window.location.href}</code>
          <button onClick={copyLink}>{copied ? 'Copied!' : 'Copy link'}</button>
        </div>
      )}

      <div className="controls">
        <button onClick={() => toggleTrack('audio')} disabled={controlsDisabled}>
          {micOn ? 'Mute' : 'Unmute'}
        </button>
        <button onClick={() => toggleTrack('video')} disabled={controlsDisabled}>
          {camOn ? 'Camera off' : 'Camera on'}
        </button>
        <button className="leave" onClick={onLeave}>
          Leave
        </button>
      </div>
    </div>
  );
}

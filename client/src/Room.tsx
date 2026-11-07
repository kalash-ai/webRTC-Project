/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChatPanel, type ChatMessage } from './chatPanel';
import { Inspector } from './Inspector';
import { useAdaptiveQuality } from './useAdaptiveQuality';
import { useLinkInfo } from './useLinkInfo';
import {
  ActivityIcon,
  CameraIcon,
  CameraOffIcon,
  ClockIcon,
  EditIcon,
  LinkIcon,
  LockIcon,
  MaximizeIcon,
  MessageIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  SwapIcon,
  VideoIcon,
} from './icons';

const SIGNALING_URL: string = import.meta.env.VITE_SIGNALING_URL ?? 'ws://localhost:8080';
const MAX_RECONNECT_ATTEMPTS = 8;
const SLOW_SERVER_MS = 5000;
const NAME_KEY = 'linkrtc-name';

type Status =
  | 'starting'
  | 'joining'
  | 'reconnecting'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'full'
  | 'denied'
  | 'error';

const STATUS_TEXT: Record<Status, string> = {
  starting: 'Starting camera...',
  joining: 'Connecting to the server...',
  reconnecting: 'Reconnecting to the server...',
  waiting: 'Waiting for the other person',
  connecting: 'Connecting...',
  connected: 'Connected',
  failed: 'Connection failed',
  full: 'This room is full (2 people max)',
  denied: 'Camera or microphone unavailable',
  error: 'Something went wrong',
};

type PipRect = { left: number; top: number; width: number };
type DragState = {
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  left: number;
  top: number;
  width: number;
};

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

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
  const stageRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingSent = useRef(false);
  const remoteTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const msgSeq = useRef(0);

  const [status, setStatus] = useState<Status>('starting');
  const [errorText, setErrorText] = useState('');
  const [serverSlow, setServerSlow] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [statsPc, setStatsPc] = useState<RTCPeerConnection | null>(null);
  const [remoteAudio, setRemoteAudio] = useState<MediaStream | null>(null);
  const [showStats, setShowStats] = useState(false);

  const [myName, setMyName] = useState<string>(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [remoteName, setRemoteName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const myNameRef = useRef(myName);
  const remoteNameRef = useRef('');

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMin, setChatMin] = useState(false);
  const [chatReady, setChatReady] = useState(false);
  const [unread, setUnread] = useState(0);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const chatVisibleRef = useRef(false);

  const [toast, setToast] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [pip, setPip] = useState<PipRect | null>(null);

  const timer = useCallTimer(status === 'connected');
  const speaking = useSpeaking(remoteAudio);
  const quality = useAdaptiveQuality(statsPc, status === 'connected');
  const link = useLinkInfo(statsPc, status === 'connected' && chatOpen && !chatMin);

  function showToast(text: string) {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

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
    let attempts = 0;
    let stopReconnect = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let slowTimer: ReturnType<typeof setTimeout> | null = null;
    // Messages are handled one at a time, in order, so awaits can't race.
    let queue: Promise<void> = Promise.resolve();

    function send(payload: object) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    }

    // ----- chat, names and typing travel over a data channel, never through the server -----
    function resetChat() {
      channelRef.current = null;
      remoteNameRef.current = '';
      if (remoteTypingTimer.current) clearTimeout(remoteTypingTimer.current);
      setRemoteName('');
      setRemoteTyping(false);
      setMessages([]);
      setUnread(0);
      setChatReady(false);
    }

    function setupChannel(ch: RTCDataChannel) {
      channelRef.current = ch;
      ch.onopen = () => {
        setChatReady(true);
        if (myNameRef.current) {
          ch.send(JSON.stringify({ type: 'name', name: myNameRef.current }));
        }
      };
      ch.onclose = () => {
        if (channelRef.current === ch) {
          channelRef.current = null;
          setChatReady(false);
          setRemoteTyping(false);
        }
      };
      ch.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg && msg.type === 'name' && typeof msg.name === 'string') {
          const name = msg.name.trim().slice(0, 24);
          remoteNameRef.current = name;
          setRemoteName(name);
        } else if (msg && msg.type === 'typing') {
          if (remoteTypingTimer.current) clearTimeout(remoteTypingTimer.current);
          setRemoteTyping(Boolean(msg.typing));
          if (msg.typing) {
            // Safety net: if the "stopped typing" message is lost, hide the dots anyway.
            remoteTypingTimer.current = setTimeout(() => setRemoteTyping(false), 4000);
          }
        } else if (msg && msg.type === 'chat' && typeof msg.text === 'string') {
          const text = msg.text.slice(0, 500);
          setRemoteTyping(false);
          setMessages((prev) => [
            ...prev,
            { id: ++msgSeq.current, from: 'them', text, time: nowTime() },
          ]);
          if (!chatVisibleRef.current) setUnread((u) => u + 1);
        }
      };
    }

    function createPeerConnection() {
      pc?.close();
      // Test switch: open the site with ?relay=1 to force the call through TURN.
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
      // The person who answers receives the chat channel the offerer created.
      conn.ondatachannel = (e) => {
        if (pc === conn) setupChannel(e.channel);
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
      setupChannel(pc.createDataChannel('chat'));
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
          if (slowTimer) clearTimeout(slowTimer);
          slowTimer = null;
          setServerSlow(false);
          attempts = 0;
          iceServers = message.iceServers ?? [];
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          setRemoteAudio(null);
          resetChat();
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
          showToast(`${remoteNameRef.current || 'Guest'} left the call`);
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          setRemoteAudio(null);
          resetChat();
          createPeerConnection(); // fresh connection, ready for the next person
          setStatus('waiting');
          break;
        }
        case 'roomFull': {
          stopReconnect = true;
          if (slowTimer) clearTimeout(slowTimer);
          setServerSlow(false);
          setStatus('full');
          break;
        }
        case 'error': {
          console.warn('Server error:', message.message);
          break;
        }
      }
    }

    function scheduleReconnect() {
      if (cancelled) return;
      if (attempts >= MAX_RECONNECT_ATTEMPTS) {
        if (slowTimer) clearTimeout(slowTimer);
        setServerSlow(false);
        setErrorText('Could not reach the signaling server. Check your connection and try again.');
        setStatus('error');
        return;
      }
      // Wait 1s, 2s, 4s, 8s, then 15s between tries (about 75 seconds in total,
      // enough for a sleeping free-tier server to wake up).
      const delay = Math.min(1000 * 2 ** attempts, 15000);
      attempts += 1;
      setStatus('reconnecting');
      reconnectTimer = setTimeout(() => connect(true), delay);
    }

    function connect(isRetry: boolean) {
      if (cancelled) return;
      setStatus(isRetry ? 'reconnecting' : 'joining');

      // If the server has not answered after a few seconds, say why.
      // The timer starts once and keeps running across retries until we join.
      if (!slowTimer) {
        slowTimer = setTimeout(() => {
          if (!cancelled) setServerSlow(true);
        }, SLOW_SERVER_MS);
      }

      const socket = new WebSocket(SIGNALING_URL);
      ws = socket;
      socket.onopen = () => send({ type: 'join', roomId });
      socket.onmessage = (ev) => {
        let message: any;
        try {
          message = JSON.parse(ev.data);
        } catch {
          return;
        }
        queue = queue.then(() => handle(message)).catch(console.error);
      };
      socket.onclose = (ev) => {
        if (cancelled || ws !== socket || stopReconnect) return;
        if (ev.code === 1008) {
          // The server refused this website (ALLOWED_ORIGINS). Retrying will not help.
          if (slowTimer) clearTimeout(slowTimer);
          setServerSlow(false);
          setErrorText('This website is not allowed to use the signaling server.');
          setStatus('error');
          return;
        }
        scheduleReconnect();
      };
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

      connect(false);
    }

    start();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (slowTimer) clearTimeout(slowTimer);
      send({ type: 'leave' });
      channelRef.current?.close();
      channelRef.current = null;
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

  // Messages count as unread unless the chat panel is open and not minimized.
  useEffect(() => {
    const visible = chatOpen && !chatMin;
    chatVisibleRef.current = visible;
    if (visible) setUnread(0);
  }, [chatOpen, chatMin]);

  // Swapping only makes sense while both videos are showing.
  useEffect(() => {
    if (status !== 'connected') setSwapped(false);
  }, [status]);

  // A resized window puts the small video back in its corner.
  useEffect(() => {
    const reset = () => setPip(null);
    window.addEventListener('resize', reset);
    return () => window.removeEventListener('resize', reset);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (remoteTypingTimer.current) clearTimeout(remoteTypingTimer.current);
    },
    [],
  );

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

  function saveName(raw: string) {
    const name = raw.trim().slice(0, 24);
    setMyName(name);
    myNameRef.current = name;
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // Storage can be blocked; the name still works for this visit.
    }
    const ch = channelRef.current;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify({ type: 'name', name }));
    }
    setEditingName(false);
  }

  // ----- chat actions -----
  function toggleChat() {
    if (chatOpen && !chatMin) {
      setChatOpen(false);
    } else {
      setChatOpen(true);
      setChatMin(false);
    }
  }

  function stopTyping() {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (!typingSent.current) return;
    typingSent.current = false;
    const ch = channelRef.current;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify({ type: 'typing', typing: false }));
    }
  }

  // Called while you type: tell the other person once, then say "stopped" after a pause.
  function notifyTyping() {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== 'open') return;
    if (!typingSent.current) {
      typingSent.current = true;
      ch.send(JSON.stringify({ type: 'typing', typing: true }));
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2500);
  }

  function sendChat(raw: string) {
    const text = raw.trim().slice(0, 500);
    const ch = channelRef.current;
    if (!text || !ch || ch.readyState !== 'open') return;
    stopTyping();
    ch.send(JSON.stringify({ type: 'chat', text }));
    setMessages((prev) => [...prev, { id: ++msgSeq.current, from: 'me', text, time: nowTime() }]);
  }

  // ----- the small video: drag to move, corner handle to resize -----
  function startDrag(e: ReactPointerEvent, mode: 'move' | 'resize') {
    const stage = stageRef.current;
    const tile = stage?.querySelector('.tile.pip') as HTMLElement | null;
    if (!stage || !tile) return;
    e.preventDefault();
    e.stopPropagation();
    const s = stage.getBoundingClientRect();
    const t = tile.getBoundingClientRect();
    const start = { left: t.left - s.left, top: t.top - s.top, width: t.width };
    setPip(start);
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, ...start };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onDragMove(e: ReactPointerEvent) {
    const d = dragRef.current;
    const stage = stageRef.current;
    const tile = stage?.querySelector('.tile.pip') as HTMLElement | null;
    if (!d || !stage || !tile) return;
    const s = stage.getBoundingClientRect();
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === 'move') {
      const t = tile.getBoundingClientRect();
      setPip({
        left: clamp(d.left + dx, 0, s.width - t.width),
        top: clamp(d.top + dy, 0, s.height - t.height),
        width: t.width,
      });
    } else {
      const width = clamp(d.width + dx, 120, Math.min(560, s.width - d.left, s.width * 0.7));
      setPip({ left: d.left, top: d.top, width });
    }
  }

  function endDrag() {
    dragRef.current = null;
  }

  function pipStyle(isPip: boolean): CSSProperties | undefined {
    if (!isPip || !pip) return undefined;
    return { left: pip.left, top: pip.top, width: pip.width, right: 'auto', bottom: 'auto' };
  }

  function pipHandlers(isPip: boolean) {
    if (!isPip) return {};
    return {
      onPointerDown: (e: ReactPointerEvent) => startDrag(e, 'move'),
      onPointerMove: onDragMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    };
  }

  function pipControls() {
    return (
      <>
        {status === 'connected' && (
          <button
            className="pip-swap"
            aria-label="Swap videos"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setSwapped((v) => !v)}
          >
            <SwapIcon size={16} />
          </button>
        )}
        <div
          className="pip-resize"
          onPointerDown={(e) => startDrag(e, 'resize')}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </>
    );
  }

  const controlsDisabled = status === 'denied' || status === 'full' || status === 'error';
  const isBusy =
    status === 'starting' ||
    status === 'joining' ||
    status === 'reconnecting' ||
    status === 'connecting';
  const failedHint = 'A strict network or firewall may be blocking the call.';
  const localLabel = myName ? `${myName} (You)` : 'You';
  const remoteLabel = remoteName || 'Guest';
  const remoteIsPip = swapped;
  const localIsPip = !swapped;

  return (
    <div className="room" ref={roomRef}>
      <div className="stage" ref={stageRef}>
        {/* The other person's video */}
        <div
          className={`tile tile-remote ${remoteIsPip ? 'pip' : 'big'}`}
          style={pipStyle(remoteIsPip)}
          {...pipHandlers(remoteIsPip)}
        >
          <video ref={remoteVideoRef} autoPlay playsInline />
          {remoteIsPip && <span className="tile-label">{remoteLabel}</span>}
          {remoteIsPip && pipControls()}
        </div>

        {/* Your own video (muted, so you never hear an echo of yourself) */}
        <div
          className={`tile tile-local ${localIsPip ? 'pip' : 'big'}`}
          style={pipStyle(localIsPip)}
          {...pipHandlers(localIsPip)}
        >
          <video ref={localVideoRef} autoPlay playsInline muted />
          {!camOn && (
            <div className="pip-off">
              <CameraOffIcon size={26} />
            </div>
          )}
          <span className="tile-label">{localLabel}</span>
          {localIsPip && pipControls()}
        </div>

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
          {status === 'connected' && quality && (
            <span className={`pill pill-quality is-${quality}`}>
              <span className="dot" />
              {quality === 'good' ? 'Sending: Good' : quality === 'fair' ? 'Sending: Fair' : 'Sending: Weak'}
            </span>
          )}
          {editingName ? (
            <input
              className="pill pill-input"
              autoFocus
              maxLength={24}
              defaultValue={myName}
              placeholder="Your name"
              onBlur={(e) => saveName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName(e.currentTarget.value);
                if (e.key === 'Escape') setEditingName(false);
              }}
            />
          ) : (
            <button className="pill pill-name" onClick={() => setEditingName(true)}>
              <EditIcon size={14} />
              {myName || 'Add your name'}
            </button>
          )}
        </div>

        {status === 'connected' && quality === 'poor' && camOn && (
          <div className="quality-banner">
            <span>Your connection is weak. Video quality was lowered automatically.</span>
            <button className="btn-secondary small" onClick={() => toggleTrack('video')}>
              Switch to audio only
            </button>
          </div>
        )}

        {toast && <div className="toast">{toast}</div>}

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
            ) : isBusy ? (
              <>
                <div className="spinner" />
                <p className="overlay-title">{STATUS_TEXT[status]}</p>
                {serverSlow && (status === 'joining' || status === 'reconnecting') && (
                  <p className="overlay-sub">
                    Waking up the server, this can take up to a minute. The free server sleeps when idle.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="overlay-title">{STATUS_TEXT[status]}</p>
                <p className="overlay-sub">{status === 'failed' ? failedHint : errorText}</p>
                {(status === 'error' || status === 'failed') && (
                  <button className="btn-secondary small" onClick={() => window.location.reload()}>
                    Try again
                  </button>
                )}
                <button className="btn-primary small" onClick={onLeave}>
                  Back to home
                </button>
              </>
            )}
          </div>
        )}

        {status === 'connected' && !swapped && (
          <div className="remote-label">
            <div className="remote-name">{remoteLabel}</div>
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

        {showStats && (
          <div className="stats-panel">
            <Inspector pc={statsPc} active={status === 'connected'} />
          </div>
        )}

        <ChatPanel
          open={chatOpen}
          minimized={chatMin}
          messages={messages}
          remoteName={remoteLabel}
          myName={myName}
          chatReady={chatReady}
          remoteTyping={remoteTyping}
          unread={unread}
          link={link}
          onSend={sendChat}
          onTyping={notifyTyping}
          onMinimize={() => setChatMin(true)}
          onExpand={() => setChatMin(false)}
          onClose={() => {
            setChatOpen(false);
            setChatMin(false);
          }}
        />
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
          className={`ctl ${chatOpen && !chatMin ? 'is-on' : ''}`}
          onClick={toggleChat}
          disabled={status !== 'connected' && !chatOpen}
        >
          <span className="ctl-icon">
            <MessageIcon size={24} />
            {unread > 0 && <span className="ctl-badge">{unread > 9 ? '9+' : unread}</span>}
          </span>
          <span className="ctl-label">Chat</span>
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
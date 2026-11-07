import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CheckIcon,
  ChevronUpIcon,
  CloseIcon,
  LockIcon,
  MessageIcon,
  MinusIcon,
  SendIcon,
  SmileIcon,
} from './icons';

export type ChatMessage = { id: number; from: 'me' | 'them'; text: string; time: string };

type Props = {
  open: boolean;
  minimized: boolean;
  messages: ChatMessage[];
  remoteName: string;
  myName: string;
  chatReady: boolean;
  remoteTyping: boolean;
  unread: number;
  link: { rttMs: number | null; relayed: boolean | null };
  onSend: (text: string) => void;
  onTyping: () => void;
  onMinimize: () => void;
  onExpand: () => void;
  onClose: () => void;
};

const EMOJIS = ['😀', '😂', '😊', '😍', '😎', '🤔', '👍', '👏', '🙏', '🎉', '🔥', '❤️', '😢', '😮', '👋', '✅'];
const CHAT_SIZE_KEY = 'linkrtc-chat-size';

function loadSavedSize(): { width: number | null; height: number | null } {
  try {
    const raw = localStorage.getItem(CHAT_SIZE_KEY);
    if (!raw) return { width: null, height: null };
    const parsed = JSON.parse(raw);
    const width = typeof parsed.width === 'number' && parsed.width >= 280 && parsed.width <= 1200 ? parsed.width : null;
    const height = typeof parsed.height === 'number' && parsed.height >= 340 && parsed.height <= 2000 ? parsed.height : null;
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function ChatPanel(p: Props) {
  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const listEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  // Resizing state
  const savedSize = useRef(loadSavedSize());
  const [panelWidth, setPanelWidth] = useState<number | null>(() => savedSize.current.width);
  const [panelHeight, setPanelHeight] = useState<number | null>(() => savedSize.current.height);
  const [isResizing, setIsResizing] = useState(false);
  const sizeRef = useRef({ width: panelWidth, height: panelHeight });
  sizeRef.current = { width: panelWidth, height: panelHeight };

  const showPanel = p.open && !p.minimized;
  const showPill = p.open && p.minimized;
  const myLabel = p.myName || 'Guest';
  const firstName = p.remoteName.split(' ')[0];
  const canSend = p.chatReady && draft.trim().length > 0;
  const lastMine = [...p.messages].reverse().find((m) => m.from === 'me');
  const lastMessage = p.messages[p.messages.length - 1];

  const route = p.link.relayed === null ? 'Connecting' : p.link.relayed ? 'Relay' : 'P2P';
  const meta = p.link.rttMs !== null ? `${route} · ${p.link.rttMs} ms` : route;

  // Keep the newest message in view.
  useEffect(() => {
    if (showPanel) listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [p.messages, p.remoteTyping, showPanel]);

  // Focus the box when the panel opens (not on touch screens, where it would pop the keyboard).
  useEffect(() => {
    if (showPanel && window.matchMedia('(pointer: fine)').matches) {
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    }
    if (!showPanel) setEmojiOpen(false);
  }, [showPanel]);

  // Clamp resized dimensions if the browser window shrinks.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 640) return;
      setPanelWidth((w) => {
        if (w === null) return null;
        const maxW = Math.min(window.innerWidth - 32, 760);
        return w > maxW ? maxW : w;
      });
      setPanelHeight((h) => {
        if (h === null) return null;
        const maxH = window.innerHeight - 88;
        return h > maxH ? maxH : h;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function startResize(e: ReactPointerEvent, mode: 'left' | 'top' | 'corner') {
    if (window.innerWidth <= 640) return;
    e.preventDefault();
    e.stopPropagation();
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    setIsResizing(true);
    const cursor = mode === 'left' ? 'ew-resize' : mode === 'top' ? 'ns-resize' : 'nwse-resize';
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';

    function onPointerMove(ev: PointerEvent) {
      ev.preventDefault();
      if (mode === 'left' || mode === 'corner') {
        const dx = startX - ev.clientX;
        const maxW = Math.min(window.innerWidth - 32, 760);
        const newW = Math.max(280, Math.min(maxW, Math.round(startWidth + dx)));
        setPanelWidth(newW);
        sizeRef.current.width = newW;
      }
      if (mode === 'top' || mode === 'corner') {
        const dy = startY - ev.clientY;
        const maxH = window.innerHeight - 88;
        const newH = Math.max(340, Math.min(maxH, Math.round(startHeight + dy)));
        setPanelHeight(newH);
        sizeRef.current.height = newH;
      }
    }

    function onPointerUp() {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      try {
        localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify(sizeRef.current));
      } catch {
        // Storage can be restricted
      }
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function resetSize() {
    setPanelWidth(null);
    setPanelHeight(null);
    sizeRef.current = { width: null, height: null };
    try {
      localStorage.removeItem(CHAT_SIZE_KEY);
    } catch {
      // Storage can be restricted
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text || !p.chatReady) return;
    p.onSend(text);
    setDraft('');
    setEmojiOpen(false);
  }

  function pillSubtitle(): string {
    if (p.remoteTyping) return `${firstName} is typing...`;
    if (p.unread > 0) return `${p.unread} new message${p.unread > 1 ? 's' : ''}`;
    if (lastMessage) return `${lastMessage.from === 'me' ? 'You: ' : ''}${lastMessage.text}`;
    return 'Conversation minimized';
  }

  const panelStyle: CSSProperties = {};
  if (panelWidth !== null) panelStyle.width = `${panelWidth}px`;
  if (panelHeight !== null) {
    panelStyle.height = `${panelHeight}px`;
    panelStyle.top = 'auto';
  }

  return (
    <>
      <aside
        ref={panelRef}
        className={`lc-panel ${showPanel ? 'is-open' : ''} ${isResizing ? 'is-resizing' : ''}`}
        style={panelStyle}
        aria-hidden={!showPanel}
        aria-label="Chat"
      >
        {/* Resize Handles */}
        <div
          className="lc-resizer lc-resizer-left"
          title="Drag to resize width (double-click to reset)"
          onPointerDown={(e) => startResize(e, 'left')}
          onDoubleClick={resetSize}
        >
          <span className="lc-resizer-grip" />
        </div>
        <div
          className="lc-resizer lc-resizer-top"
          title="Drag to resize height (double-click to reset)"
          onPointerDown={(e) => startResize(e, 'top')}
          onDoubleClick={resetSize}
        />
        <div
          className="lc-resizer lc-resizer-corner"
          title="Drag to resize width and height (double-click to reset)"
          onPointerDown={(e) => startResize(e, 'corner')}
          onDoubleClick={resetSize}
        />

        <div className="lc-head">
          <div className="lc-avatar">{initials(p.remoteName)}</div>
          <div className="lc-who">
            <div className="lc-name">{p.remoteName}</div>
            <div className="lc-sub">
              <span className="lc-dot" />
              {myLabel} (You) · Live call
            </div>
          </div>
          <button className="lc-icon-btn" onClick={p.onMinimize} aria-label="Minimize chat">
            <MinusIcon size={18} />
          </button>
          <button className="lc-icon-btn" onClick={p.onClose} aria-label="Close chat">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="lc-link">
          <span className="lc-chip">
            <LockIcon size={13} />
            Encrypted DataChannel
          </span>
          <span className="lc-meta">{meta}</span>
        </div>

        <div className="lc-list">
          {p.messages.length > 0 && <div className="lc-day">TODAY · {p.messages[0].time}</div>}
          {p.messages.length === 0 && (
            <p className="lc-empty">
              {p.chatReady ? 'No messages yet. Say hello.' : 'Chat starts when someone is connected.'}
            </p>
          )}
          {p.messages.map((m, i) => {
            const prev = p.messages[i - 1];
            const showMeta = !prev || prev.from !== m.from;
            const isMe = m.from === 'me';
            return (
              <div key={m.id} className={`cmsg ${isMe ? 'cmsg-me' : 'cmsg-them'}`}>
                {showMeta && (
                  <div className="cmsg-meta">
                    <span>{isMe ? `${myLabel} (You)` : p.remoteName}</span>
                    <time>{m.time}</time>
                  </div>
                )}
                <div className="cmsg-bubble">{m.text}</div>
                {isMe && lastMine && m.id === lastMine.id && (
                  <span className="cmsg-sent">
                    <CheckIcon size={12} />
                    Sent
                  </span>
                )}
              </div>
            );
          })}
          {p.remoteTyping && (
            <div className="lc-typing">
              <span className="lc-typing-bubble">
                <i />
                <i />
                <i />
              </span>
              <span className="lc-typing-text">{firstName} is typing</span>
            </div>
          )}
          <div ref={listEndRef} />
        </div>

        <div className="lc-composer">
          <div className="lc-box">
            <input
              ref={inputRef}
              value={draft}
              maxLength={500}
              disabled={!p.chatReady}
              placeholder={p.chatReady ? 'Type a message...' : 'Waiting for connection...'}
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v);
                if (v.trim()) p.onTyping();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
              }}
            />
            <div className="lc-emoji-wrap">
              <button
                type="button"
                className="lc-icon-btn"
                aria-label="Add emoji"
                disabled={!p.chatReady}
                onClick={() => setEmojiOpen((v) => !v)}
              >
                <SmileIcon size={20} />
              </button>
              {emojiOpen && (
                <div className="lc-emoji-pop">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        setDraft((d) => (d + emoji).slice(0, 500));
                        p.onTyping();
                        inputRef.current?.focus();
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="lc-send" onClick={submit} disabled={!canSend} aria-label="Send message">
              <SendIcon size={18} />
            </button>
          </div>
          <div className="lc-foot">
            <span>Only you and {firstName} can read this</span>
            <span>⏎ to send</span>
          </div>
        </div>
      </aside>

      <div className={`lc-pill ${showPill ? 'is-open' : ''}`} aria-hidden={!showPill}>
        <button className="lc-pill-main" onClick={p.onExpand} aria-label="Expand chat">
          <span className="lc-pill-icon">
            <MessageIcon size={20} />
            {p.unread > 0 && <b className="lc-badge">{p.unread > 9 ? '9+' : p.unread}</b>}
          </span>
          <span className="lc-pill-text">
            <strong>{p.remoteName}</strong>
            <small>{pillSubtitle()}</small>
          </span>
        </button>
        <span className="lc-lock">
          <LockIcon size={16} />
        </span>
        <button className="lc-icon-btn" onClick={p.onExpand} aria-label="Expand chat">
          <ChevronUpIcon size={18} />
        </button>
        <button className="lc-icon-btn" onClick={p.onClose} aria-label="Close chat">
          <CloseIcon size={18} />
        </button>
      </div>
    </>
  );
}
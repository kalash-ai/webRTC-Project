import { useEffect, useRef, useState } from 'react';
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

  return (
    <>
      <aside className={`lc-panel ${showPanel ? 'is-open' : ''}`} aria-hidden={!showPanel} aria-label="Chat">
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
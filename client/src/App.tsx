import { useEffect, useState } from 'react';
import { Room } from './Room';
import './index.css';
import {
  ArrowRightIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  PlusIcon,
  VideoIcon,
  ZapIcon,
} from './icons';

// Links look like  https://your-site/#/room/abc123...
// Hash routing needs no router library and no server rewrite rules.
const ROOM_HASH = /^#\/room\/([A-Za-z0-9_-]{6,64})$/;
const ROOM_ID = /^[A-Za-z0-9_-]{6,64}$/;

function useRoomId(): string | null {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const match = hash.match(ROOM_HASH);
  return match ? match[1] : null;
}

function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// Accepts a full link or just the room ID.
function extractRoomId(input: string): string | null {
  const text = input.trim();
  const fromLink = text.match(/room\/([A-Za-z0-9_-]{6,64})/);
  if (fromLink) return fromLink[1];
  return ROOM_ID.test(text) ? text : null;
}

function Home() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  function createRoom() {
    window.location.hash = `#/room/${newRoomId()}`;
  }

  function join() {
    const id = extractRoomId(value);
    if (!id) {
      setError("That doesn't look like a room link.");
      return;
    }
    window.location.hash = `#/room/${id}`;
  }

  return (
    <div className="home">
      <header className="home-header">
        <div className="brand">
          <span className="brand-icon">
            <VideoIcon size={22} />
          </span>
          <span className="brand-name">LinkRTC</span>
        </div>
        <div className="home-tag">
          <GlobeIcon size={18} />
          <span>Made for your browser</span>
        </div>
      </header>

      <main className="home-main">
        <span className="chip">
          <ZapIcon size={16} />
          Built on WebRTC
        </span>
        <h1>
          Frictionless
          <br />
          Video Calls
        </h1>
        <p className="lead">
          One link. A real conversation.
          <br />
          No downloads, no sign-ups, just connect.
        </p>

        <button className="btn-primary" onClick={createRoom}>
          <PlusIcon size={22} />
          Create New Room
        </button>

        <div className="divider">
          <span>or join a room</span>
        </div>

        <label className="field-label" htmlFor="room-link">
          Enter Room Link
        </label>
        <div className="join-row">
          <div className="input-wrap">
            <LinkIcon size={20} />
            <input
              id="room-link"
              type="text"
              placeholder="Paste a room link"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') join();
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button className="btn-secondary" onClick={join}>
            Join
            <ArrowRightIcon size={18} />
          </button>
        </div>
        {error && <p className="field-error">{error}</p>}

        <p className="home-note">
          <LockIcon size={16} />
          Private, peer-to-peer. Always.
        </p>
      </main>

      <footer className="home-footer">Less setup. More connection.</footer>
    </div>
  );
}

export default function App() {
  const roomId = useRoomId();

  if (roomId) {
    return (
      <Room
        key={roomId}
        roomId={roomId}
        onLeave={() => {
          window.location.hash = '';
        }}
      />
    );
  }

  return <Home />;
}
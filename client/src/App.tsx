import { useEffect, useState } from 'react';
import { Room } from './room';

// Links look like  https://your-site/#/room/abc123...
// Hash routing needs no router library and no server rewrite rules.
const ROOM_HASH = /^#\/room\/([A-Za-z0-9_-]{6,64})$/;

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

  return (
    <div className="home">
      <h1>Callroom</h1>
      <p>Start a video call, then share the link with one other person.</p>
      <button
        onClick={() => {
          window.location.hash = `#/room/${newRoomId()}`;
        }}
      >
        Start a new call
      </button>
    </div>
  );
}

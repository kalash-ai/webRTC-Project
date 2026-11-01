import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

// ---------- config (all from environment, nothing secret in code) ----------
const PORT = Number(process.env.PORT) || 8080;
const METERED_APP_NAME = process.env.METERED_APP_NAME; // e.g. "myapp" from myapp.metered.live
const METERED_API_KEY = process.env.METERED_API_KEY;
// Comma-separated list, e.g. "https://my-app.vercel.app,http://localhost:5173".
// If empty, any origin is allowed (fine for local dev only).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const MAX_PEERS_PER_ROOM = 2;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// ---------- ICE servers (STUN + TURN) ----------
async function getIceServers(): Promise<unknown[]> {
    if (!METERED_APP_NAME || !METERED_API_KEY) {
        return FALLBACK_ICE_SERVERS; // STUN only: works on the same network, not across strict NATs
    }
    try {
        const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Metered responded ${res.status}`);
        const servers = await res.json();
        if (!Array.isArray(servers) || servers.length === 0) throw new Error('empty ICE list');
        return servers;
    } catch (err) {
        console.error('Could not fetch TURN credentials, falling back to STUN only:', err);
        return FALLBACK_ICE_SERVERS;
    }
}

// ---------- state ----------
const rooms = new Map<string, Set<WebSocket>>(); // roomId -> sockets in it
const roomOf = new Map<WebSocket, string>(); // socket -> roomId
const alive = new WeakMap<WebSocket, boolean>(); // heartbeat flag

function send(ws: WebSocket, payload: object) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function othersInRoom(ws: WebSocket): WebSocket[] {
    const roomId = roomOf.get(ws);
    if (!roomId) return [];
    const room = rooms.get(roomId);
    if (!room) return [];
    return [...room].filter((peer) => peer !== ws);
}

function leaveRoom(ws: WebSocket) {
    const roomId = roomOf.get(ws);
    if (!roomId) return;
    const room = rooms.get(roomId);
    roomOf.delete(ws);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) {
        rooms.delete(roomId);
    } else {
        for (const peer of room) send(peer, { type: 'peerLeft' });
    }
    console.log(`left room ${roomId} (${room.size} remaining)`);
}

// ---------- HTTP + WebSocket server ----------
// The plain HTTP endpoint gives Render a health check and lets you ping the
// service to wake it up from free-tier sleep.
const server = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }
    res.writeHead(404);
    res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.length > 0 && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
        ws.close(1008, 'origin not allowed');
        return;
    }

    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', console.error);
    ws.on('close', () => leaveRoom(ws));

    ws.on('message', async (data) => {
        // Never let a malformed message crash the server.
        let message: any;
        try {
            message = JSON.parse(data.toString());
        } catch {
            send(ws, { type: 'error', message: 'Invalid JSON' });
            return;
        }
        if (!message || typeof message.type !== 'string') {
            send(ws, { type: 'error', message: 'Invalid message' });
            return;
        }

        switch (message.type) {
            case 'join': {
                if (roomOf.has(ws)) return; // already in a room
                const roomId = message.roomId;
                if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
                    send(ws, { type: 'error', message: 'Invalid room ID' });
                    return;
                }
                const room = rooms.get(roomId) ?? new Set<WebSocket>();
                if (room.size >= MAX_PEERS_PER_ROOM) {
                    send(ws, { type: 'roomFull' });
                    return;
                }
                // Reserve the seat synchronously, before any await, so two people
                // joining at the same moment cannot both squeeze in.
                room.add(ws);
                rooms.set(roomId, room);
                roomOf.set(ws, roomId);
                console.log(`joined room ${roomId} (${room.size}/${MAX_PEERS_PER_ROOM})`);

                const iceServers = await getIceServers();
                if (ws.readyState !== WebSocket.OPEN) {
                    leaveRoom(ws); // they left while we were fetching credentials
                    return;
                }
                const peers = othersInRoom(ws);
                send(ws, { type: 'joined', iceServers, peerPresent: peers.length > 0 });
                // The peer who was already waiting will create the offer.
                for (const peer of peers) send(peer, { type: 'peerJoined' });
                break;
            }

            case 'createOffer':
            case 'createAnswer': {
                if (!message.sdp) return;
                for (const peer of othersInRoom(ws)) {
                    send(peer, { type: message.type, sdp: message.sdp });
                }
                break;
            }

            case 'iceCandidate': {
                if (!message.candidate) return;
                for (const peer of othersInRoom(ws)) {
                    send(peer, { type: 'iceCandidate', candidate: message.candidate });
                }
                break;
            }

            case 'leave': {
                leaveRoom(ws);
                break;
            }

            default:
                send(ws, { type: 'error', message: `Unknown message type: ${message.type}` });
        }
    });
});

// Drop connections that stopped responding (closed laptop, lost network).
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
            ws.terminate();
            continue;
        }
        alive.set(ws, false);
        ws.ping();
    }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
    console.log(`Signaling server listening on port ${PORT}`);
    if (!METERED_APP_NAME || !METERED_API_KEY) {
        console.log('METERED_* not set: using STUN only (fine for local testing).');
    }
});
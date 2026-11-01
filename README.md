# LinkRTC

[Live Deployment: Insert URL Here]

LinkRTC is a lightweight, strictly peer-to-peer video calling web application built to demonstrate core WebRTC networking concepts. Developed as a technical portfolio project during my first year of B.Tech CSE (AI/ML) at Kalinga Institute of Industrial Technology, it focuses on fundamental real-time communication mechanics without relying on heavy third-party communication SDKs. The application pairs a React frontend with a custom native WebSocket signaling server to negotiate connections.

### Features

* **Frictionless Room Creation:** Generates random, hash-routed URLs for instant joining without requiring a backend database or user accounts.
* **Native WebRTC Integration:** Uses vanilla `RTCPeerConnection` for direct, low-latency audio and video streams.
* **Cross-Network Reliability:** Integrated with Metered's Open Relay to dynamically fetch STUN and TURN server credentials, enabling connections across complex NATs and mobile data networks.
* **Custom Signaling:** A lean Node.js `ws` server handles the initial handshake and peer discovery.
* **Responsive Dark UI:** A custom, CSS-driven interface optimized for both desktop and mobile viewports.

### How It Works

* **Signaling:** Before two browsers can send video to each other, they need to know how to connect. The Node.js WebSocket server acts as a temporary matchmaker, passing introduction messages between users until a direct connection is established.
* **SDP Offer/Answer:** The first user creates a Session Description Protocol (SDP) "Offer"—a text profile of their media capabilities (codecs, resolutions). The server relays this to the second user, who replies with an "Answer" to agree on the media format.
* **ICE Candidates:** While negotiating media capabilities, the browsers also need to figure out their network paths. They generate Interactive Connectivity Establishment (ICE) candidates (potential IP/port routing options) and exchange them via the signaling server.
* **STUN/TURN:** If users are behind basic home routers, a STUN server helps them discover their own public IP address. If strict firewalls or mobile carrier NATs block direct peer-to-peer connections, the application falls back to a TURN server, which acts as a secure cloud relay to bounce the encrypted video stream between them.

### Local Setup

To run this project locally, you will need a free API key from Metered Open Relay for the TURN server credentials.

1. Clone the repository:
```bash
git clone https://github.com/Kalash-ai/LinkRTC.git
cd LinkRTC

```


2. Install dependencies (this installs root, client, and server packages):
```bash
npm install

```


3. Create a `.env` file in the root directory and add your Metered API key:
```env
METERED_API_KEY=your_api_key_here

```


4. Start both the Vite frontend and Node signaling server simultaneously:
```bash
npm run dev

```


5. Open `http://localhost:5173` in your browser.

### What I Learned & Future Improvements

Building this project exposed me to the complexities of network traversal and the strict state machine of the WebRTC API. I learned how to manage asynchronous media stream requests alongside React's component lifecycle, and how to safely pass environment variables from a backend server to a client to keep credentials secure.

**Current Limitations:**

* The signaling server currently uses basic in-memory variable management. It is optimized for 1-on-1 calls and will drop connection state if the server restarts.
* It lacks horizontal scalability (e.g., Redis pub/sub), so the signaling backend cannot currently be distributed across multiple server instances.
* Video quality adapts automatically via the browser's internal engine, but manual bit-rate throttling and network degradation UI warnings are not yet implemented.

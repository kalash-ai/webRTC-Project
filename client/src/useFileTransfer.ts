/* eslint-disable @typescript-eslint/no-explicit-any, no-control-regex */
import { useEffect, useRef } from 'react';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024; // 16 KB works in every browser
const HIGH_WATER = 1024 * 1024; // pause sending above 1 MB waiting in the buffer
const LOW_WATER = 256 * 1024; // resume when it drops below 256 KB
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const RISKY_NAME = /\.(exe|bat|cmd|com|msi|scr|apk|jar|js|vbs|ps1|sh|app|dmg|pkg)$/i;

export type FileStatus = 'queued' | 'sending' | 'receiving' | 'done' | 'failed' | 'cancelled';

export type FileItem = {
  transferId: string;
  name: string;
  size: number;
  direction: 'me' | 'them';
  status: FileStatus;
  progress: number; // 0 to 1
  url?: string;
  preview?: boolean;
  risky?: boolean;
  error?: string;
};

type Options = {
  channelRef: { current: RTCDataChannel | null };
  onAdd: (file: FileItem) => void;
  onUpdate: (transferId: string, patch: Partial<FileItem>) => void;
  onIncoming?: () => void;
};

type Incoming = {
  id: string;
  name: string;
  size: number;
  mime: string;
  received: number;
  chunks: ArrayBuffer[];
  lastPct: number;
};
type Queued = { id: string; file: File };
type State = {
  incoming: Incoming | null;
  queue: Queued[];
  sending: boolean;
  cancelled: Set<string>;
  urls: string[];
};

export type FileApi = {
  sendFiles: (list: File[]) => void;
  cancel: (transferId: string) => void;
  /** Returns true if the message was a file message (so chat code should ignore it). */
  handleChannelMessage: (data: unknown) => boolean;
  abortAll: () => void;
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function cleanName(name: string): string {
  const cleaned = name
    .replace(/[\\\/\u0000-\u001f<>:"|?*]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || 'file';
}

function waitForDrain(c: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      c.removeEventListener('bufferedamountlow', done);
      c.removeEventListener('close', done);
      resolve();
    };
    c.addEventListener('bufferedamountlow', done);
    c.addEventListener('close', done);
  });
}

function createFileApi(optsRef: { current: Options }, st: State): FileApi {
  const channel = () => optsRef.current.channelRef.current;
  const add = (f: FileItem) => optsRef.current.onAdd(f);
  const update = (id: string, patch: Partial<FileItem>) => optsRef.current.onUpdate(id, patch);

  function sendJson(obj: object): boolean {
    const c = channel();
    if (!c || c.readyState !== 'open') return false;
    c.send(JSON.stringify(obj));
    return true;
  }

  // ---------- sending ----------
  async function sendOne({ id, file }: Queued) {
    if (st.cancelled.has(id)) {
      st.cancelled.delete(id);
      update(id, { status: 'cancelled' });
      return;
    }
    const c = channel();
    if (!c || c.readyState !== 'open') {
      update(id, { status: 'failed', error: 'Chat is not connected' });
      return;
    }
    update(id, { status: 'sending' });
    c.binaryType = 'arraybuffer';
    c.bufferedAmountLowThreshold = LOW_WATER;
    sendJson({ type: 'file-start', id, name: cleanName(file.name), size: file.size, mime: file.type });

    let offset = 0;
    let lastPct = -1;
    try {
      while (offset < file.size) {
        if (st.cancelled.has(id)) {
          st.cancelled.delete(id);
          sendJson({ type: 'file-cancel', id });
          update(id, { status: 'cancelled' });
          return;
        }
        if (c.readyState !== 'open') throw new Error('The connection closed');
        if (c.bufferedAmount > HIGH_WATER) await waitForDrain(c);
        const buf = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
        if (c.readyState !== 'open') throw new Error('The connection closed');
        c.send(buf);
        offset += buf.byteLength;
        const pct = Math.floor((offset / file.size) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          update(id, { progress: offset / file.size });
        }
      }
      sendJson({ type: 'file-end', id });
      update(id, { status: 'done', progress: 1 });
    } catch (err) {
      update(id, { status: 'failed', error: err instanceof Error ? err.message : 'Could not send' });
    }
  }

  async function pump() {
    if (st.sending) return;
    st.sending = true;
    try {
      while (st.queue.length > 0) {
        const next = st.queue.shift()!;
        await sendOne(next);
      }
    } finally {
      st.sending = false;
    }
  }

  function sendFiles(list: File[]) {
    for (const file of list) {
      const id = crypto.randomUUID();
      const base: FileItem = {
        transferId: id,
        name: cleanName(file.name),
        size: file.size,
        direction: 'me',
        status: 'queued',
        progress: 0,
      };
      if (file.size === 0) {
        add({ ...base, status: 'failed', error: 'The file is empty' });
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        add({ ...base, status: 'failed', error: `Too large (max ${formatBytes(MAX_FILE_BYTES)})` });
        continue;
      }
      const c = channel();
      if (!c || c.readyState !== 'open') {
        add({ ...base, status: 'failed', error: 'Chat is not connected' });
        continue;
      }
      const preview = IMAGE_TYPES.includes(file.type);
      let url: string | undefined;
      if (preview) {
        url = URL.createObjectURL(file);
        st.urls.push(url);
      }
      add({ ...base, preview, url });
      st.queue.push({ id, file });
    }
    void pump();
  }

  function cancel(id: string) {
    const qi = st.queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      st.queue.splice(qi, 1);
      update(id, { status: 'cancelled' });
      return;
    }
    if (st.incoming && st.incoming.id === id) {
      st.incoming = null;
      sendJson({ type: 'file-cancel', id });
      update(id, { status: 'cancelled' });
      return;
    }
    st.cancelled.add(id); // currently sending: the send loop will notice
  }

  // ---------- receiving ----------
  function onStart(msg: any) {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
    const size = Number(msg.size);
    if (!id) return;
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
      sendJson({ type: 'file-cancel', id });
      return;
    }
    if (st.incoming) update(st.incoming.id, { status: 'failed', error: 'Replaced by another file' });
    const name = cleanName(String(msg.name ?? 'file'));
    st.incoming = { id, name, size, mime: String(msg.mime ?? ''), received: 0, chunks: [], lastPct: -1 };
    add({
      transferId: id,
      name,
      size,
      direction: 'them',
      status: 'receiving',
      progress: 0,
      risky: RISKY_NAME.test(name),
    });
    optsRef.current.onIncoming?.();
  }

  function onChunk(data: ArrayBuffer) {
    const inc = st.incoming;
    if (!inc) return;
    inc.chunks.push(data);
    inc.received += data.byteLength;
    if (inc.received > inc.size) {
      st.incoming = null;
      sendJson({ type: 'file-cancel', id: inc.id });
      update(inc.id, { status: 'failed', error: 'Received more data than expected' });
      return;
    }
    const pct = Math.floor((inc.received / inc.size) * 100);
    if (pct !== inc.lastPct) {
      inc.lastPct = pct;
      update(inc.id, { progress: inc.received / inc.size });
    }
  }

  function onEnd(msg: any) {
    const inc = st.incoming;
    if (!inc || inc.id !== msg.id) return;
    st.incoming = null;
    if (inc.received !== inc.size) {
      update(inc.id, { status: 'failed', error: 'The file arrived incomplete' });
      return;
    }
    const isImage = IMAGE_TYPES.includes(inc.mime);
    const blob = new Blob(inc.chunks, { type: isImage ? inc.mime : 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    st.urls.push(url);
    update(inc.id, { status: 'done', progress: 1, url, preview: isImage });
  }

  function onCancelMsg(msg: any) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (st.incoming && st.incoming.id === id) {
      st.incoming = null;
      update(id, { status: 'cancelled' });
    } else if (id) {
      st.cancelled.add(id); // the other side stopped our upload
    }
  }

  function handleChannelMessage(data: unknown): boolean {
    if (typeof data === 'string') {
      let msg: any;
      try {
        msg = JSON.parse(data);
      } catch {
        return false;
      }
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('file-')) return false;
      if (msg.type === 'file-start') onStart(msg);
      else if (msg.type === 'file-end') onEnd(msg);
      else if (msg.type === 'file-cancel') onCancelMsg(msg);
      return true;
    }
    if (data instanceof ArrayBuffer) {
      onChunk(data);
      return true;
    }
    return false;
  }

  function abortAll() {
    if (st.incoming) {
      update(st.incoming.id, { status: 'failed', error: 'The connection closed' });
      st.incoming = null;
    }
    for (const q of st.queue) update(q.id, { status: 'failed', error: 'The connection closed' });
    st.queue = [];
    st.cancelled.clear();
  }

  return { sendFiles, cancel, handleChannelMessage, abortAll };
}

export function useFileTransfer(options: Options): FileApi {
  const optsRef = useRef(options);
  optsRef.current = options;
  const stateRef = useRef<State>({
    incoming: null,
    queue: [],
    sending: false,
    cancelled: new Set<string>(),
    urls: [],
  });
  const apiRef = useRef<FileApi | null>(null);
  if (apiRef.current === null) {
    apiRef.current = createFileApi(optsRef, stateRef.current);
  }

  // Free the memory behind download links when the call screen closes.
  useEffect(() => {
    const st = stateRef.current;
    return () => {
      st.urls.forEach((u) => URL.revokeObjectURL(u));
      st.urls = [];
    };
  }, []);

  return apiRef.current;
}
import { CloseIcon, DownloadIcon, FileIcon } from './icons';
import { formatBytes, type FileItem } from './useFileTransfer';

export function FileBubble({ file, onCancel }: { file: FileItem; onCancel: (id: string) => void }) {
  const active = file.status === 'queued' || file.status === 'sending' || file.status === 'receiving';
  const pct = Math.round(file.progress * 100);

  let statusText = '';
  if (file.status === 'queued') statusText = 'Waiting';
  else if (file.status === 'sending') statusText = `Sending ${pct}%`;
  else if (file.status === 'receiving') statusText = `Receiving ${pct}%`;
  else if (file.status === 'done') statusText = file.direction === 'me' ? 'Sent' : 'Ready to download';
  else if (file.status === 'failed') statusText = 'Failed';
  else statusText = 'Cancelled';

  return (
    <div className="fb">
      {file.preview && file.url && file.status !== 'failed' && file.status !== 'cancelled' && (
        <img className="fb-thumb" src={file.url} alt={file.name} />
      )}
      <div className="fb-row">
        <span className="fb-icon">
          <FileIcon size={20} />
        </span>
        <div className="fb-info">
          <div className="fb-name" title={file.name}>
            {file.name}
          </div>
          <div className="fb-sub">
            {formatBytes(file.size)} · {statusText}
          </div>
        </div>
        {active && (
          <button className="fb-btn" onClick={() => onCancel(file.transferId)} aria-label="Cancel transfer">
            <CloseIcon size={16} />
          </button>
        )}
        {file.direction === 'them' && file.status === 'done' && file.url && (
          <a className="fb-btn" href={file.url} download={file.name} aria-label="Download file">
            <DownloadIcon size={18} />
          </a>
        )}
      </div>
      {active && (
        <div className="fb-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {file.risky && file.direction === 'them' && (
        <div className="fb-warn">This file type can run programs. Only open it if you trust the sender.</div>
      )}
      {file.error && <div className="fb-err">{file.error}</div>}
    </div>
  );
}
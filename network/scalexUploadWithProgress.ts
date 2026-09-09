/**
 * ScaleX LAN Manager upload progress tracker.
 *
 * Two payload shapes reach this plugin from DragonFruit core
 * (`uploadPrintJobWithProgress`, see `network/index.ts`):
 *
 * - `zipFilePath` (a native temp file on disk) — this is the path
 *   DragonFruit's desktop build actually uses today (`printingArtifact.blob`
 *   is currently always null in core, so this is the only branch exercised
 *   in practice). Handled server-side (`scalex/upload/start`,
 *   `scalex/upload/progress` — see `network/handlers/upload.ts`) via a
 *   Node `http` stream, since a webview client can't stream an arbitrary
 *   native file itself.
 * - `zipBlob` — an in-memory Blob, sent directly as a raw POST body via XHR
 *   (same idea as Athena's NanoDLP blob path), so progress comes straight
 *   from `xhr.upload.onprogress`, no server round-trip needed.
 *
 * IMPORTANT — filename/extension: ScaleX needs the *real* slicer output
 * extension (e.g. `.ctb`) in `X-File-Name` so the printer firmware
 * recognizes the format; unlike NanoDLP, it isn't a proprietary endpoint
 * that can accept an arbitrary made-up name. The native-path branch derives
 * this correctly from `zipFilePath`'s own extension. The Blob branch cannot
 * — `uploadPrintJobWithProgress`'s generic contract only passes `path`
 * (the filename *without* its extension, see `src/app/page.tsx`'s
 * `pathBase`), so it falls back to `.ctb` (this deployment's actual format)
 * with a console warning. If DragonFruit core ever starts populating
 * `zipBlob` for a printer whose output isn't `.ctb`, that fallback would be
 * wrong — flagged here rather than silently guessed away; see this plugin's
 * README.
 *
 * Also by design: every upload here is queue-only (`startPrint: false`).
 * `uploadPrintJobWithProgress`'s shared contract has no "start printing"
 * field to begin with, and own_manager.py's own SESSION NOTES document a
 * printer starting a real print on ScaleX's "experimental" bulk endpoint
 * without ever being asked to — so this plugin doesn't wire up
 * auto-starting a print at all in v1. Use ScaleX's own UI (or the
 * `startScaleXStoredFile` helper in `network/scalexClient.ts`, if a future
 * monitoring adapter is added) to start a queued job.
 */

import { pluginNetworkFetch, readNativeFileSize } from '@/utils/pluginNetworkBridge';

export type UploadProgressEvent = {
  loaded: number;
  total: number;
  uploadSpeed: string;
  remainingTime: string;
  transferred: string;
  percentComplete: number;
};

export type UploadStatusUpdate = {
  stage: 'uploading' | 'processing' | 'complete' | 'error';
  message: string;
  progress?: UploadProgressEvent;
  plateId?: number | null;
  error?: string;
};

type UploadCallbacks = {
  onProgress: (event: UploadProgressEvent) => void;
  onStatusUpdate: (update: UploadStatusUpdate) => void;
  onComplete?: (plateId: number | null) => void;
  onError?: (error: string) => void;
};

function bytesToStringRep(bytes: number): string {
  const absolute = Math.max(0, bytes);
  if (absolute >= 1000000000) return `${(absolute / 1000000000).toFixed(absolute >= 10000000000 ? 0 : 1)} Gb`;
  if (absolute >= 1000000) return `${(absolute / 1000000).toFixed(absolute >= 10000000 ? 0 : 1)} Mb`;
  if (absolute >= 1000) return `${(absolute / 1000).toFixed(absolute >= 10000 ? 0 : 1)} Kb`;
  return `${Math.round(absolute)} b`;
}

function secondsToTimeString(seconds: number): string {
  const normalized = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  const secs = normalized % 60;
  const temp = (normalized - secs) / 60;
  const mins = temp % 60;
  const hrs = (temp - mins) / 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function parseHostAndPortFromUrl(hostUrl: string): { host: string; port: number } {
  const trimmed = hostUrl.trim();
  if (!trimmed) throw new Error('Host URL is required for ScaleX upload');
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(normalized);
  const host = parsed.hostname.trim();
  if (!host) throw new Error('Invalid host URL for ScaleX upload');
  const port = parsed.port ? Number(parsed.port) : 8082;
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('Invalid host port for ScaleX upload');
  return { host, port };
}

function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Blob path: raw POST body via XHR, real progress from `xhr.upload`. Mirrors
 * Athena's `uploadToNanoDlpWithProgress`.
 */
export async function uploadToScaleXWithProgress(
  hostUrl: string,
  zipBlob: Blob,
  path: string,
  printerId: string,
  callbacks: UploadCallbacks,
): Promise<{ ok: boolean; plateId: number | null }> {
  const { host, port } = parseHostAndPortFromUrl(hostUrl);
  // See the file-level doc comment: the real extension isn't available here.
  console.warn('[ScaleXLanManager] Uploading a Blob without a known extension — assuming .ctb. See scalexUploadWithProgress.ts.');
  const fileName = `${path}.ctb`;

  return new Promise((resolve, reject) => {
    let lastProgressTs = Date.now();
    let lastProgressLoaded = 0;
    const uploadStartedTs = Date.now();
    let smoothedBytesPerSecond = 0;

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e: ProgressEvent<XMLHttpRequestUpload>) => {
      if (!e.lengthComputable) return;
      const percentComplete = Math.round(((e.loaded / e.total) * 100) * 100) / 100;

      const now = Date.now();
      const timeSinceLastCall = Math.max(1, now - lastProgressTs);
      const amountSinceLastCall = e.loaded - lastProgressLoaded;
      lastProgressTs = now;
      lastProgressLoaded = e.loaded;

      const instantaneous = Math.max(0, amountSinceLastCall / (timeSinceLastCall / 1000));
      const elapsedSeconds = Math.max(0.001, (now - uploadStartedTs) / 1000);
      const average = Math.max(0, e.loaded / elapsedSeconds);
      smoothedBytesPerSecond = smoothedBytesPerSecond <= 0
        ? (instantaneous || average)
        : (smoothedBytesPerSecond * 0.8) + (instantaneous * 0.2);
      const effective = Math.max(average * 0.65, (smoothedBytesPerSecond * 0.75) + (average * 0.25));
      const secondsRemaining = effective > 0 ? (e.total - e.loaded) / effective : 0;

      const progressEvent: UploadProgressEvent = {
        loaded: e.loaded,
        total: e.total,
        uploadSpeed: `${bytesToStringRep(effective)}/s`,
        remainingTime: secondsToTimeString(secondsRemaining),
        transferred: `${bytesToStringRep(e.loaded)} / ${bytesToStringRep(e.total)}`,
        percentComplete,
      };
      callbacks.onProgress(progressEvent);

      if (e.loaded === e.total) {
        callbacks.onStatusUpdate({ stage: 'processing', message: 'File uploaded, ScaleX is processing…', progress: progressEvent });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        callbacks.onStatusUpdate({ stage: 'complete', message: 'Upload complete' });
        callbacks.onComplete?.(null);
        resolve({ ok: true, plateId: null });
      } else {
        const error = `HTTP ${xhr.status}: ${xhr.statusText}`;
        callbacks.onStatusUpdate({ stage: 'error', message: 'Upload failed', error });
        callbacks.onError?.(error);
        reject(new Error(error));
      }
    });

    xhr.addEventListener('error', () => {
      const error = 'Network error during upload';
      callbacks.onStatusUpdate({ stage: 'error', message: error, error });
      callbacks.onError?.(error);
      reject(new Error(error));
    });

    xhr.addEventListener('abort', () => {
      const error = 'Upload canceled';
      callbacks.onStatusUpdate({ stage: 'error', message: error, error });
      callbacks.onError?.(error);
      reject(new Error(error));
    });

    xhr.open('POST', `http://${host}:${port}/api/printers/${encodeURIComponent(printerId)}/files`);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(fileName));
    xhr.setRequestHeader('X-Start-Print', 'false');
    xhr.send(zipBlob);
  });
}

/** Native-file-path branch: server-side streaming via scalex/upload/start, polled via scalex/upload/progress. */
export async function uploadToScaleXFromPathWithProgress(
  hostUrl: string,
  zipFilePath: string,
  path: string,
  printerId: string,
  callbacks: UploadCallbacks,
): Promise<{ ok: boolean; plateId: number | null }> {
  const normalizedPath = zipFilePath.trim();
  if (!normalizedPath) throw new Error('zipFilePath is required for native ScaleX upload');

  const { host, port } = parseHostAndPortFromUrl(hostUrl);
  const fileName = basenameOf(normalizedPath);
  const uploadId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `scalex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const fileSize = await readNativeFileSize(normalizedPath);
  const knownTotal = Number.isFinite(fileSize) && (fileSize ?? 0) > 0 ? Number(fileSize) : null;

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  const uploadStartedTs = Date.now();
  let lastTs = uploadStartedTs;
  let lastLoaded = 0;
  let smoothedBytesPerSecond = 0;
  let currentTotal = knownTotal ?? 0;
  let sentFully = false;

  const emitProgress = (loadedInput: number, totalInput: number, phase: 'uploading' | 'processing' | 'complete' = 'uploading') => {
    const safeTotal = Math.max(1, Math.round(totalInput));
    const loaded = Math.max(0, Math.min(Math.round(loadedInput), safeTotal));

    const now = Date.now();
    const timeSinceLastCall = Math.max(1, now - lastTs);
    const amountSinceLastCall = Math.max(0, loaded - lastLoaded);
    lastTs = now;
    lastLoaded = loaded;

    const instantaneous = Math.max(0, amountSinceLastCall / (timeSinceLastCall / 1000));
    const elapsedSeconds = Math.max(0.001, (now - uploadStartedTs) / 1000);
    const average = Math.max(0, loaded / elapsedSeconds);
    if (phase === 'uploading') {
      smoothedBytesPerSecond = smoothedBytesPerSecond <= 0
        ? (instantaneous || average)
        : (smoothedBytesPerSecond * 0.8) + (instantaneous * 0.2);
    }
    const effective = phase === 'uploading' ? Math.max(average * 0.65, (smoothedBytesPerSecond * 0.75) + (average * 0.25)) : 0;

    const uploadSpeed = phase === 'complete' ? 'done' : phase === 'processing' ? 'uploaded' : effective > 0 ? `${bytesToStringRep(effective)}/s` : 'starting…';
    const remainingTime = phase === 'complete' ? '00:00:00' : phase === 'processing' ? 'processing…' : effective > 0 ? secondsToTimeString((safeTotal - loaded) / effective) : 'estimating…';
    const transferred = currentTotal > 0 ? `${bytesToStringRep(loaded)} / ${bytesToStringRep(safeTotal)}` : `${bytesToStringRep(loaded)} / unknown`;

    callbacks.onProgress({
      loaded,
      total: safeTotal,
      uploadSpeed,
      remainingTime,
      transferred,
      percentComplete: phase === 'complete' ? 100 : Math.round(((loaded / safeTotal) * 100) * 100) / 100,
    });
  };

  const pollProgress = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const response = await pluginNetworkFetch({ pluginId: 'scalex-lan-manager', operation: 'scalex/upload/progress', uploadId });
      if (!response.ok) return;
      const payloadRaw = await response.json().catch(() => ({}));
      const payload = (payloadRaw && typeof payloadRaw === 'object' ? payloadRaw : {}) as Record<string, unknown>;
      const upload = (payload.upload && typeof payload.upload === 'object' ? payload.upload : null) as Record<string, unknown> | null;
      if (!upload) return;

      const sentBytes = Number(upload.sentBytes);
      const totalBytes = Number(upload.totalBytes);
      if (!Number.isFinite(sentBytes) || sentBytes < 0 || !Number.isFinite(totalBytes) || totalBytes <= 0) return;

      currentTotal = Math.max(1, Math.round(totalBytes));
      const loaded = Math.max(0, Math.min(Math.round(sentBytes), currentTotal));

      if (loaded >= currentTotal && !sentFully) {
        sentFully = true;
        if (progressTimer !== null) { clearInterval(progressTimer); progressTimer = null; }
        callbacks.onStatusUpdate({ stage: 'processing', message: 'File uploaded, ScaleX is processing…' });
      } else if (loaded < currentTotal) {
        emitProgress(loaded, currentTotal, 'uploading');
      }
    } finally {
      pollInFlight = false;
    }
  };

  callbacks.onStatusUpdate({ stage: 'uploading', message: 'Uploading print job to ScaleX LAN Manager…' });
  emitProgress(0, knownTotal ?? 1, 'uploading');
  progressTimer = setInterval(() => { void pollProgress(); }, 280);
  void pollProgress();

  try {
    const response = await pluginNetworkFetch({
      pluginId: 'scalex-lan-manager',
      operation: 'scalex/upload/start',
      host,
      ipAddress: host,
      port,
      uploadId,
      printerId,
      filePath: normalizedPath,
      fileName,
      startPrint: false,
    });

    const payloadRaw = await response.json().catch(() => ({}));
    const payload = (payloadRaw && typeof payloadRaw === 'object' ? payloadRaw : {}) as Record<string, unknown>;

    if (!response.ok || payload.ok === false) {
      const reason = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(reason);
    }

    if (!sentFully) {
      sentFully = true;
      callbacks.onStatusUpdate({ stage: 'processing', message: 'File uploaded, ScaleX is processing…' });
    }

    callbacks.onStatusUpdate({ stage: 'complete', message: 'Upload complete' });
    callbacks.onComplete?.(null);
    const finalTotal = currentTotal > 0 ? currentTotal : (knownTotal ?? 1);
    emitProgress(finalTotal, finalTotal, 'complete');

    return { ok: true, plateId: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload print job to ScaleX LAN Manager';
    callbacks.onStatusUpdate({ stage: 'error', message: 'Upload failed', error: message });
    callbacks.onError?.(message);
    throw error;
  } finally {
    if (progressTimer !== null) { clearInterval(progressTimer); progressTimer = null; }
  }
}

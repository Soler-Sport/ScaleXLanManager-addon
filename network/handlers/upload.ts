import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  fetchScaleXPrinters,
  fetchScaleXUploadStatus,
  isScaleXUploadError,
  isScaleXUploadTerminal,
  parseScaleXHostAndPort,
  progressFromScaleXUploadStatus,
  resolveScaleXPort,
  resolveScaleXRawHost,
  startScaleXStoredFile,
  type ScaleXPrinter,
} from '../scalexClient';

type HandlerResult = {
  status: number;
  body: unknown;
};

type UploadProgressEntry = {
  sentBytes: number;
  totalBytes: number;
  done: boolean;
  error: string | null;
};

/**
 * Server-side (Node) upload tracking, keyed by the client-generated
 * `uploadId` from scalexUploadWithProgress.ts's native-file-path branch.
 * Process-lifetime only — same scope NanoDLP's own native-path progress
 * tracking has (it lives in Athena's Rust side instead; this plugin does the
 * equivalent in plain TS since ScaleX doesn't need a native encoder or any
 * other reason to touch Rust).
 */
const uploadProgressById = new Map<string, UploadProgressEntry>();

/**
 * Stream a file straight to `POST /api/printers/{id}/files` using Node's
 * `http` module (not `fetch`) so we get real byte-level progress as the
 * request body is written, mirroring own_manager.py's own raw
 * `http.client`-based upload. `X-File-Name` carries the real filename
 * (including the correct slicer-output extension) — see this plugin's
 * README for why that has to come from the caller rather than being
 * guessed here.
 */
function streamUploadToScaleX(opts: {
  host: string;
  port: number;
  printerId: string;
  filePath: string;
  fileName: string;
  totalBytes: number;
  startPrint: boolean;
  onProgress: (sentBytes: number) => void;
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host,
        port: opts.port,
        method: 'POST',
        path: `/api/printers/${encodeURIComponent(opts.printerId)}/files`,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(opts.totalBytes),
          'X-File-Name': encodeURIComponent(opts.fileName),
          'X-Start-Print': opts.startPrint ? 'true' : 'false',
        },
        timeout: 30 * 60 * 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = raw;
          try {
            body = raw.length > 0 ? JSON.parse(raw) : {};
          } catch {
            // Non-JSON response body — surface the raw text as-is.
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Upload to ScaleX timed out')));

    const readStream = createReadStream(opts.filePath);
    let sent = 0;
    readStream.on('data', (chunk: Buffer | string) => {
      sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      opts.onProgress(sent);
    });
    readStream.on('error', (err) => {
      req.destroy(err);
      reject(err);
    });
    readStream.pipe(req);
  });
}

function findPrinter(printers: ScaleXPrinter[], printerId: string): ScaleXPrinter | null {
  return printers.find((p) => String(p.id) === printerId) ?? null;
}

/**
 * `scalex/upload/start` — reads `payload.filePath` off disk and streams it to
 * the chosen printer. Ported from own_manager.py's send_in_background()
 * safety rule: never send `X-Start-Print: true` to a printer that isn't
 * `operatorPrepared` — upload without starting instead, then register a
 * deferred start via `/stored-files/start` with `queueIfNotPrepared: true`
 * so it fires once an operator confirms preparation on the printer itself.
 */
export async function handleScaleXUploadStart(payload: unknown): Promise<HandlerResult> {
  const record = (payload ?? {}) as Record<string, unknown>;
  const rawHost = resolveScaleXRawHost(payload);
  const parsedHost = parseScaleXHostAndPort(rawHost);
  const uploadId = typeof record.uploadId === 'string' ? record.uploadId : '';
  const printerId = typeof record.printerId === 'string' ? record.printerId : '';
  const filePath = typeof record.filePath === 'string' ? record.filePath : '';
  const fileName = typeof record.fileName === 'string' && record.fileName.trim().length > 0 ? record.fileName.trim() : '';
  const startPrintRequested = record.startPrint === true;

  if (!parsedHost) return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  if (!uploadId) return { status: 400, body: { ok: false, error: 'Missing uploadId' } };
  if (!printerId) return { status: 400, body: { ok: false, error: 'Missing printerId' } };
  if (!filePath) return { status: 400, body: { ok: false, error: 'Missing filePath' } };
  if (!fileName) return { status: 400, body: { ok: false, error: 'Missing fileName' } };

  const port = resolveScaleXPort(record.port, parsedHost.port);

  let totalBytes = 0;
  try {
    totalBytes = (await stat(filePath)).size;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read file';
    return { status: 400, body: { ok: false, error: message } };
  }

  uploadProgressById.set(uploadId, { sentBytes: 0, totalBytes, done: false, error: null });

  let printer: ScaleXPrinter | null = null;
  try {
    const printers = await fetchScaleXPrinters(parsedHost.host, port, 6000);
    printer = findPrinter(printers, printerId);
  } catch {
    // Non-fatal: proceed without the preparedness/memory pre-check, ScaleX's
    // own upload response is still the final word either way.
  }

  const printerPrepared = printer?.operatorPrepared === true;
  const needsDeferredStart = startPrintRequested && !printerPrepared;
  const effectiveStartPrint = startPrintRequested && !needsDeferredStart;

  try {
    const uploadResult = await streamUploadToScaleX({
      host: parsedHost.host,
      port,
      printerId,
      filePath,
      fileName,
      totalBytes,
      startPrint: effectiveStartPrint,
      onProgress: (sentBytes) => {
        const entry = uploadProgressById.get(uploadId);
        if (entry) entry.sentBytes = sentBytes;
      },
    });

    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      const message = `HTTP ${uploadResult.status}`;
      uploadProgressById.set(uploadId, { sentBytes: totalBytes, totalBytes, done: true, error: message });
      return { status: 200, body: { ok: false, error: message, scalexResponse: uploadResult.body } };
    }

    const body = (uploadResult.body ?? {}) as Record<string, unknown>;
    const scalexUploadId = typeof body.uploadId === 'string' ? body.uploadId : null;
    let lastUploadedPath = typeof body.lastUploadedPath === 'string' ? body.lastUploadedPath : null;

    if (scalexUploadId) {
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        const status = await fetchScaleXUploadStatus(parsedHost.host, port, scalexUploadId, 10000);
        if (typeof status.lastUploadedPath === 'string') lastUploadedPath = status.lastUploadedPath;
        if (isScaleXUploadTerminal(status)) {
          if (isScaleXUploadError(status)) {
            const { message } = progressFromScaleXUploadStatus(status);
            uploadProgressById.set(uploadId, { sentBytes: totalBytes, totalBytes, done: true, error: message || 'Upload failed' });
            return { status: 200, body: { ok: false, error: message || 'Upload failed' } };
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (needsDeferredStart) {
      if (!lastUploadedPath) {
        uploadProgressById.set(uploadId, { sentBytes: totalBytes, totalBytes, done: true, error: 'No lastUploadedPath to start from' });
        return { status: 200, body: { ok: false, error: 'Upload finished, but ScaleX did not report a stored file path to start printing from.' } };
      }
      const startResult = await startScaleXStoredFile(parsedHost.host, port, printerId, lastUploadedPath, true);
      if (startResult.status < 200 || startResult.status >= 300) {
        uploadProgressById.set(uploadId, { sentBytes: totalBytes, totalBytes, done: true, error: `Deferred start HTTP ${startResult.status}` });
        return { status: 200, body: { ok: false, error: `Uploaded, but queuing the deferred start failed (HTTP ${startResult.status}).` } };
      }
    }

    uploadProgressById.set(uploadId, { sentBytes: totalBytes, totalBytes, done: true, error: null });
    return { status: 200, body: { ok: true, printerId, deferredStart: needsDeferredStart } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload to ScaleX failed';
    uploadProgressById.set(uploadId, { sentBytes: 0, totalBytes, done: true, error: message });
    return { status: 200, body: { ok: false, error: message } };
  }
}

/** `scalex/upload/progress` — polled by scalexUploadWithProgress.ts's native-file-path branch. */
export async function handleScaleXUploadProgress(payload: unknown): Promise<HandlerResult> {
  const record = (payload ?? {}) as Record<string, unknown>;
  const uploadId = typeof record.uploadId === 'string' ? record.uploadId : '';
  const entry = uploadId ? uploadProgressById.get(uploadId) : undefined;
  if (!entry) {
    return { status: 200, body: { upload: null } };
  }
  return {
    status: 200,
    body: {
      upload: {
        sentBytes: entry.sentBytes,
        totalBytes: entry.totalBytes,
        done: entry.done,
        error: entry.error,
      },
    },
  };
}

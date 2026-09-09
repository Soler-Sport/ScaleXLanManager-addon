/**
 * Low-level ScaleX LAN Manager HTTP client.
 *
 * ScaleX LAN Manager is a self-hosted FastAPI/uvicorn service (source:
 * https://github.com/Soler-Sport/ScaleX-Lan-Manager_Addon_Network-Sending)
 * that sits in front of a farm of SDCP-speaking resin printers (Elegoo
 * Saturn 4 / EL3D-4 in the reference deployment) and exposes a small REST
 * API for uploading already-sliced files and tracking their transfer.
 *
 * This file only wraps that API (host/port parsing, `fetch` calls, response
 * shapes). It intentionally does not implement `/api/ctb/patch-and-upload`
 * or the bulk/`from-draft` endpoints: ScaleX's own reference client
 * (`own_manager.py`) documents both as risky ("experimental" per ScaleX's
 * own API responses, and observed live starting a print without being
 * asked to) — see this plugin's README for details. Everything here only
 * uses the endpoints `own_manager.py`'s own live send path actually uses.
 */

export type ScaleXPrinterStatus = {
  online?: boolean;
  currentStatus?: number;
  printStatus?: number;
  printStatusText?: string;
  remainingMemory?: number;
  [key: string]: unknown;
};

export type ScaleXUploadRef = {
  done?: boolean;
  cancelled?: boolean;
  [key: string]: unknown;
};

export type ScaleXPrinter = {
  id: string;
  name?: string;
  displayName?: string;
  model?: string;
  machineModel?: string;
  operatorPrepared?: boolean;
  recommendedNormalExposure?: number | string;
  recommendedBottomExposure?: number | string;
  recommendedBottomLayers?: number | string;
  status?: ScaleXPrinterStatus;
  upload?: ScaleXUploadRef;
  [key: string]: unknown;
};

export type ScaleXUploadStatus = {
  done?: boolean;
  state?: string;
  percent?: number;
  stage?: string;
  lastUploadedPath?: string;
  targets?: Array<{ percent?: number; state?: string; stage?: string }>;
  [key: string]: unknown;
};

const DEFAULT_PORT = 8082;

/** Read the host the frontend sent us under whichever field name it used. */
export function resolveScaleXRawHost(payload: unknown): string {
  const record = (payload ?? {}) as Record<string, unknown>;
  const candidate = record.host ?? record.ipAddress ?? record.hostUrl ?? '';
  return typeof candidate === 'string' ? candidate.trim() : '';
}

/**
 * Parse a `host`, `host:port`, or `http(s)://host:port` string into
 * `{ host, port }`. Returns null when no usable hostname/IP is present.
 */
export function parseScaleXHostAndPort(rawHost: string): { host: string; port: number | null } | null {
  const trimmed = rawHost.trim();
  if (!trimmed) return null;

  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const url = new URL(normalized);
    const host = url.hostname.trim();
    if (!host) return null;
    const port = url.port ? Number(url.port) : null;
    if (port !== null && (!Number.isFinite(port) || port < 1 || port > 65535)) return null;
    return { host, port };
  } catch {
    return null;
  }
}

/** Resolve the effective port from an explicit payload value, a parsed URL port, or the ScaleX default (8082). */
export function resolveScaleXPort(payloadPort: unknown, parsedPort: number | null): number {
  const fromPayload = Number(payloadPort);
  if (Number.isFinite(fromPayload) && fromPayload >= 1 && fromPayload <= 65535) return fromPayload;
  if (parsedPort !== null) return parsedPort;
  return DEFAULT_PORT;
}

export function buildScaleXBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

async function scalexFetch(
  host: string,
  port: number,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(`${buildScaleXBaseUrl(host, port)}${path}`, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** GET /api/printers — the whole farm snapshot. Confirmed live against own_manager.py's fetch_printers(). */
export async function fetchScaleXPrinters(host: string, port: number, timeoutMs = 6000): Promise<ScaleXPrinter[]> {
  const response = await scalexFetch(host, port, '/api/printers', { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const decoded = await response.json().catch(() => null);
  if (!Array.isArray(decoded)) {
    throw new Error('Unexpected /api/printers payload shape (expected a JSON array)');
  }
  return decoded as ScaleXPrinter[];
}

/**
 * `printer.upload` is populated by ScaleX while a transfer targeting that
 * printer is in flight, independent of `printStatus` (the printer can still
 * read "idle" for the whole transfer). Ported from own_manager.py's
 * printer_is_uploading().
 */
export function isScaleXPrinterUploading(printer: ScaleXPrinter): boolean {
  const upload = printer.upload;
  if (!upload) return false;
  return !(upload.done || upload.cancelled);
}

const BUSY_IDLE_TEXT = new Set(['idle', 'stopped', 'complete', 'completed']);
const BUSY_TEXT = new Set(['preparing', 'homing', 'lifting', 'exposing', 'printing', 'pausing', 'paused', 'stopping']);

/** Ported from own_manager.py's printer_is_busy(). */
export function isScaleXPrinterBusy(printer: ScaleXPrinter): boolean {
  if (isScaleXPrinterUploading(printer)) return true;
  const status = printer.status ?? {};
  const currentStatus = Number(status.currentStatus ?? 0) || 0;
  const printStatus = Number(status.printStatus ?? 0) || 0;
  const text = String(status.printStatusText ?? '').toLowerCase();
  if (currentStatus === 0 || printStatus === 8 || printStatus === 9 || BUSY_IDLE_TEXT.has(text)) return false;
  return currentStatus === 1 || (printStatus >= 1 && printStatus <= 7) || BUSY_TEXT.has(text);
}

export function isScaleXPrinterOnline(printer: ScaleXPrinter): boolean {
  return (printer.status ?? {}).online === true;
}

/** Ported from own_manager.py's printer_memory_fit(): null when the printer doesn't report remainingMemory at all. */
export function scaleXPrinterMemoryFit(printer: ScaleXPrinter, fileSizeBytes: number): { fits: boolean; remainingBytes: number } | null {
  const remaining = Number((printer.status ?? {}).remainingMemory);
  if (!Number.isFinite(remaining)) return null;
  return { fits: remaining >= fileSizeBytes, remainingBytes: remaining };
}

/**
 * GET /api/uploads/{uploadId} — poll once. Works for the plain single-printer
 * upload path this plugin uses (`/api/printers/{id}/files`).
 */
export async function fetchScaleXUploadStatus(host: string, port: number, uploadId: string, timeoutMs = 8000): Promise<ScaleXUploadStatus> {
  const response = await scalexFetch(host, port, `/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
  const decoded = await response.json().catch(() => null);
  if (!response.ok || !decoded || typeof decoded !== 'object') {
    throw new Error(`HTTP ${response.status}`);
  }
  return decoded as ScaleXUploadStatus;
}

/** Best-effort (percent, message) out of an /api/uploads/{id} status payload. Ported from own_manager.py's _progress_from_status(). */
export function progressFromScaleXUploadStatus(status: ScaleXUploadStatus): { percent: number | null; message: string } {
  if (typeof status.percent === 'number') {
    return { percent: status.percent, message: String(status.stage ?? status.state ?? '') };
  }
  return { percent: null, message: String(status.state ?? status.stage ?? '') };
}

export function isScaleXUploadTerminal(status: ScaleXUploadStatus): boolean {
  return status.done === true || status.state === 'completed' || status.state === 'failed' || status.state === 'error' || status.state === 'cancelled';
}

export function isScaleXUploadError(status: ScaleXUploadStatus): boolean {
  return status.state === 'failed' || status.state === 'error' || status.state === 'cancelled';
}

/**
 * POST /api/printers/{id}/stored-files/start — the two-step "start once an
 * operator confirms preparation" mechanism. Only used when a start was
 * requested for a printer that isn't `operatorPrepared` yet, mirroring
 * own_manager.py's send_in_background(): never send `X-Start-Print: true`
 * blind to an unprepared printer.
 */
export async function startScaleXStoredFile(
  host: string,
  port: number,
  printerId: string,
  storedPath: string,
  queueIfNotPrepared: boolean,
  timeoutMs = 10000,
): Promise<{ status: number; body: unknown }> {
  const response = await scalexFetch(
    host,
    port,
    `/api/printers/${encodeURIComponent(printerId)}/stored-files/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: storedPath, queueIfNotPrepared }),
    },
    timeoutMs,
  );
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

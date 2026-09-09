/**
 * ScaleX LAN Manager network barrel (client-safe).
 *
 * Mirrors Athena's split: this file (and everything it exports) must stay
 * safe to import from browser/webview code. Server-only logic
 * (`node:http`/`node:fs`) lives in `scalexHandlers.ts` and
 * `handlers/upload.ts`, and is NOT re-exported here.
 */

import { uploadToScaleXFromPathWithProgress, uploadToScaleXWithProgress } from './scalexUploadWithProgress';

export * from './scalexUploadWithProgress';

export async function uploadPrintJobWithProgress(args: {
  hostUrl: string;
  zipBlob?: Blob | null;
  zipFilePath?: string | null;
  path: string;
  profileId: string;
  callbacks: {
    onProgress: (event: {
      loaded: number;
      total: number;
      uploadSpeed: string;
      remainingTime: string;
      transferred: string;
      percentComplete: number;
    }) => void;
    onStatusUpdate: (update: {
      stage: 'uploading' | 'processing' | 'complete' | 'error';
      message: string;
      progress?: {
        loaded: number;
        total: number;
        uploadSpeed: string;
        remainingTime: string;
        transferred: string;
        percentComplete: number;
      };
      plateId?: number | null;
      error?: string;
    }) => void;
    onComplete?: (plateId: number | null) => void;
    onError?: (error: string) => void;
  };
}): Promise<{ ok: boolean; plateId: number | null }> {
  // `profileId` is the ScaleX printer id — see network/handlers/printers.ts
  // for why this plugin repurposes the "material profile" slot as the
  // printer picker.
  const printerId = args.profileId;
  if (!printerId) {
    throw new Error('No target printer selected (profileId is empty).');
  }

  const normalizedPath = typeof args.zipFilePath === 'string' ? args.zipFilePath.trim() : '';
  if (normalizedPath.length > 0) {
    return uploadToScaleXFromPathWithProgress(args.hostUrl, normalizedPath, args.path, printerId, args.callbacks);
  }

  if (args.zipBlob && args.zipBlob.size > 0) {
    return uploadToScaleXWithProgress(args.hostUrl, args.zipBlob, args.path, printerId, args.callbacks);
  }

  throw new Error('No ScaleX upload payload available: expected zipBlob or zipFilePath.');
}

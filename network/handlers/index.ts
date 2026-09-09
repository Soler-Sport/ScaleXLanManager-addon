import { handleScaleXConnect } from './connect';
import { handleScaleXDiscover } from './discover';
import { handleScaleXPrinterEdit, handleScaleXPrinterList } from './printers';
import { handleScaleXUploadProgress, handleScaleXUploadStart } from './upload';

type HandlerResult = {
  status: number;
  body: unknown;
};

/**
 * Routes a `scalex/*` operation (already stripped of its `scalex/` prefix by
 * scalexHandlers.ts) to the matching handler. `op` strings intentionally
 * mirror the `operations` map in pluginDefinition.ts's network adapter.
 */
export async function dispatchScaleXOperation(op: string, payload: unknown): Promise<HandlerResult | null> {
  if (op === 'connect') return handleScaleXConnect(payload);
  if (op === 'discover') return handleScaleXDiscover(payload);
  if (op === 'printers/list') return handleScaleXPrinterList(payload);
  if (op === 'printers/edit') return handleScaleXPrinterEdit();
  if (op === 'upload/start') return handleScaleXUploadStart(payload);
  if (op === 'upload/progress') return handleScaleXUploadProgress(payload);
  return null;
}

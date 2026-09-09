import { dispatchScaleXOperation } from './handlers';

type HandlerResult = {
  status: number;
  body: unknown;
};

/**
 * ScaleX LAN Manager plugin's server-side network operation entrypoint.
 *
 * This file (and everything it imports from `./handlers`) depends on Node
 * APIs (`node:http`, `node:fs`) and must stay server-only — it is NOT
 * exported from `network/index.ts`, mirroring Athena's own split between
 * `nanodlpHandlers.ts` (server-only) and `network/index.ts` (client-safe
 * barrel). See `network/networkHandlers.ts` for the generated-registry entrypoint.
 */
export async function handleScaleXNetworkOperation(operationPath: string[], payload: unknown): Promise<HandlerResult> {
  if (operationPath.length === 0 || operationPath[0] !== 'scalex') {
    return { status: 404, body: { error: 'Unknown ScaleX LAN Manager network operation' } };
  }

  const op = operationPath.slice(1).join('/');
  const handled = await dispatchScaleXOperation(op, payload);
  if (handled) return handled;

  return { status: 404, body: { error: `Unknown ScaleX LAN Manager operation: ${op}` } };
}

// Generic compile-time registration alias used by generated plugin registries.
export const handlePluginNetworkOperation = handleScaleXNetworkOperation;

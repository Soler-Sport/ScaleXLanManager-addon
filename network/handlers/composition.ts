import {
  fetchScaleXWarehouseComponents,
  parseScaleXHostAndPort,
  resolveScaleXPort,
  resolveScaleXRawHost,
  saveScaleXCtbComposition,
} from '../scalexClient';

type HandlerResult = {
  status: number;
  body: unknown;
};

/** `scalex/composition/warehouse` — GET /api/warehouse, for client-side matching against the plate's model names (see `compositionMatch.ts`). */
export async function handleScaleXCompositionWarehouse(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveScaleXRawHost(payload);
  const parsedHost = parseScaleXHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }
  const port = resolveScaleXPort((payload as Record<string, unknown> | null)?.port, parsedHost.port);

  try {
    const components = await fetchScaleXWarehouseComponents(parsedHost.host, port, 10000);
    return { status: 200, body: { ok: true, components } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch ScaleX warehouse components';
    return { status: 200, body: { ok: false, error: message, components: [] } };
  }
}

/**
 * `scalex/composition/save` — PUT /api/warehouse/ctb-mappings. Best-effort,
 * fire-and-forget from the caller's perspective, mirroring own_manager.py's
 * `_save_composition_in_background()`: a failure here must never block or
 * fail the real print-job upload, only be logged by the caller. Refuses to
 * write an empty `componentQuantities` list as a no-op rather than an
 * error — see `saveScaleXCtbComposition`'s own doc comment for why.
 */
export async function handleScaleXCompositionSave(payload: unknown): Promise<HandlerResult> {
  const record = (payload ?? {}) as Record<string, unknown>;
  const rawHost = resolveScaleXRawHost(payload);
  const parsedHost = parseScaleXHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { ok: false, error: 'Invalid host or IP address' } };
  }
  const port = resolveScaleXPort(record.port, parsedHost.port);
  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  const rawQuantities = Array.isArray(record.componentQuantities) ? record.componentQuantities : [];
  const componentQuantities = rawQuantities
    .map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const componentId = e.componentId;
      const quantity = Number(e.quantity);
      if ((typeof componentId !== 'string' && typeof componentId !== 'number') || !Number.isFinite(quantity) || quantity <= 0) {
        return null;
      }
      return { componentId, quantity };
    })
    .filter((v): v is { componentId: string | number; quantity: number } => v !== null);

  if (!fileName) {
    return { status: 400, body: { ok: false, error: 'Missing fileName' } };
  }
  if (componentQuantities.length === 0) {
    return { status: 200, body: { ok: true, skipped: true } };
  }

  try {
    await saveScaleXCtbComposition(parsedHost.host, port, fileName, componentQuantities, 15000);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save ScaleX CTB composition';
    return { status: 200, body: { ok: false, error: message } };
  }
}

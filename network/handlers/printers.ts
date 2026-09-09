import {
  fetchScaleXPrinters,
  isScaleXPrinterBusy,
  isScaleXPrinterOnline,
  parseScaleXHostAndPort,
  resolveScaleXPort,
  resolveScaleXRawHost,
  type ScaleXPrinter,
} from '../scalexClient';

type HandlerResult = {
  status: number;
  body: unknown;
};

/**
 * ScaleX manages many printers behind one host:port, but DragonFruit's
 * generic network-plugin contract models one connection as one printer, with
 * a single per-job "material profile" pick (`materials`/`materialsEdit`,
 * threaded through to upload as `profileId`). There's no separate "which
 * printer" slot to reuse instead.
 *
 * So this plugin repurposes the material-profile picker as the *printer*
 * picker: each ScaleX-managed printer is surfaced here as a "material" whose
 * id is the ScaleX printer id. `network/scalexUploadWithProgress.ts` then
 * sends the job to `profileId` (i.e. the chosen printer). See this plugin's
 * README for the full rationale.
 */
function printerDisplayName(printer: ScaleXPrinter): string {
  const name = (printer.displayName || printer.name || printer.model || printer.machineModel || '').toString().trim();
  return name.length > 0 ? name : `Printer ${printer.id}`;
}

function printerLabel(printer: ScaleXPrinter): string {
  const name = printerDisplayName(printer);
  if (!isScaleXPrinterOnline(printer)) return `${name} (offline)`;
  if (isScaleXPrinterBusy(printer)) return `${name} (busy)`;
  return name;
}

export async function handleScaleXPrinterList(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveScaleXRawHost(payload);
  const parsedHost = parseScaleXHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { error: 'Invalid host or IP address' } };
  }
  const port = resolveScaleXPort((payload as Record<string, unknown> | null)?.port, parsedHost.port);

  try {
    const printers = await fetchScaleXPrinters(parsedHost.host, port, 6000);
    const materials = printers.map((printer) => ({
      id: String(printer.id),
      name: printerLabel(printer),
      locked: !isScaleXPrinterOnline(printer) || isScaleXPrinterBusy(printer),
      meta: printer,
    }));

    return {
      status: 200,
      body: {
        ipAddress: parsedHost.host,
        port,
        materials,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch ScaleX printers';
    return {
      status: 200,
      body: {
        ipAddress: parsedHost.host,
        port,
        materials: [],
        error: message,
      },
    };
  }
}

/**
 * ScaleX doesn't expose an API to edit a printer's recommended
 * exposure/material settings (those come back read-only in `/api/printers`)
 * — `remoteMaterialEditingWipNotice` in pluginDefinition.ts tells the UI to
 * grey the Edit button out, but this still needs to exist to satisfy the
 * capability contract, and to fail clearly if it's ever called anyway.
 */
export async function handleScaleXPrinterEdit(): Promise<HandlerResult> {
  return {
    status: 400,
    body: { ok: false, error: 'ScaleX LAN Manager does not support editing printer settings remotely.' },
  };
}

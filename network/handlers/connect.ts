import {
  fetchScaleXPrinters,
  isScaleXPrinterBusy,
  isScaleXPrinterOnline,
  parseScaleXHostAndPort,
  resolveScaleXPort,
  resolveScaleXRawHost,
} from '../scalexClient';

type HandlerResult = {
  status: number;
  body: unknown;
};

/**
 * Validate that a ScaleX LAN Manager host is reachable.
 *
 * Unlike NanoDLP (one connection = one printer), ScaleX manages a whole farm
 * behind a single host:port, so "connect" here checks the *manager*, not a
 * specific printer — `printerName`/`printerModel` summarize the farm instead
 * of naming one device. Picking which farm printer a job actually goes to
 * happens later, via the `materials` operation (see handlers/printers.ts).
 */
export async function handleScaleXConnect(payload: unknown): Promise<HandlerResult> {
  const rawHost = resolveScaleXRawHost(payload);
  const parsedHost = parseScaleXHostAndPort(rawHost);
  if (!parsedHost) {
    return { status: 400, body: { error: 'Invalid host or IP address' } };
  }

  const port = resolveScaleXPort((payload as Record<string, unknown> | null)?.port, parsedHost.port);

  try {
    const printers = await fetchScaleXPrinters(parsedHost.host, port, 5000);
    const online = printers.filter(isScaleXPrinterOnline).length;
    const busy = printers.filter(isScaleXPrinterBusy).length;

    return {
      status: 200,
      body: {
        connected: true,
        mode: 'scalex',
        hostName: 'ScaleX LAN Manager',
        printerName: `${printers.length} printer${printers.length === 1 ? '' : 's'} (${online} online, ${busy} busy)`,
        printerModel: '',
        ipAddress: parsedHost.host,
        port,
        statusText: 'Online',
        state: '',
        firmwareVersion: '',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reach ScaleX LAN Manager';
    return {
      status: 200,
      body: {
        connected: false,
        mode: 'scalex',
        hostName: '',
        printerName: '',
        printerModel: '',
        ipAddress: parsedHost.host,
        port,
        statusText: message,
        state: '',
        firmwareVersion: '',
      },
    };
  }
}

import { fetchScaleXPrinters, parseScaleXHostAndPort, resolveScaleXPort, resolveScaleXRawHost } from '../scalexClient';

type HandlerResult = {
  status: number;
  body: unknown;
};

type ScaleXDiscoveredDevice = {
  ipAddress: string;
  port: number;
  hostName: string;
  printerName: string;
  printerModel: string;
  statusText: string;
  state: string;
  firmwareVersion: string;
};

/**
 * ScaleX LAN Manager has no LAN broadcast/mDNS advertisement (confirmed by
 * `own_manager.py`, which just hardcodes `SCALEX_HOST`/`SCALEX_PORT`) — so,
 * unlike NanoDLP's subnet scan, this doesn't sweep the local /24. It only
 * probes a host the caller already has a hint for: an explicit host/IP from
 * the payload, or a short list of hostnames people commonly give a
 * self-hosted farm manager on their LAN.
 */
const DEFAULT_LOCAL_HOSTNAMES = ['scalex.local', 'scalex-lan-manager.local', 'printfarm.local'];

async function probeScaleX(host: string, port: number, timeoutMs: number): Promise<ScaleXDiscoveredDevice | null> {
  try {
    const printers = await fetchScaleXPrinters(host, port, timeoutMs);
    return {
      ipAddress: host,
      port,
      hostName: 'ScaleX LAN Manager',
      printerName: `${printers.length} printer${printers.length === 1 ? '' : 's'}`,
      printerModel: '',
      statusText: 'Online',
      state: '',
      firmwareVersion: '',
    };
  } catch {
    return null;
  }
}

export async function handleScaleXDiscover(payload: unknown): Promise<HandlerResult> {
  const record = (payload ?? {}) as Record<string, unknown>;
  const mode = record.mode;
  if (mode && mode !== 'scalex') {
    return { status: 400, body: { error: 'Unsupported network mode' } };
  }

  const rawHost = resolveScaleXRawHost(payload);
  const forcedHostParsed = rawHost.length > 0 ? parseScaleXHostAndPort(rawHost) : null;
  const port = resolveScaleXPort(record.port, forcedHostParsed?.port ?? null);

  const candidateHosts = forcedHostParsed
    ? [forcedHostParsed.host]
    : Array.from(new Set([
      ...(Array.isArray(record.localHostnames) ? record.localHostnames.filter((h): h is string => typeof h === 'string') : []),
      ...DEFAULT_LOCAL_HOSTNAMES,
    ]));

  const probeTimeoutMs = 1500;
  const results = await Promise.all(candidateHosts.map((host) => probeScaleX(host, port, probeTimeoutMs)));
  const devices = results.filter((device): device is ScaleXDiscoveredDevice => device !== null);

  return {
    status: 200,
    body: {
      mode: 'scalex',
      devices,
      scannedHosts: candidateHosts.length,
      scannedEndpoints: candidateHosts.length,
      scannedLocalHostnames: forcedHostParsed ? 0 : candidateHosts.length,
      scannedSubnetHosts: 0,
      scanScope: forcedHostParsed ? 'forced-host' : 'local-hostnames',
    },
  };
}

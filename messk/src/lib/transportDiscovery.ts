import { appConfig, normalizeBackendOrigin, toWebSocketOrigin } from './config';
import { fetchWithTimeout } from './http';

const BOOTSTRAP_TIMEOUT_MS = 3_000;
const MAX_DISCOVERED_ORIGINS = 32;

export type BootstrapRelayCapability = {
  endpointOrigins?: string[];
  transports?: string[];
};

type BootstrapResponse = {
  relays?: BootstrapRelayCapability[];
};

export function relayEndpointOrigins(relays: BootstrapRelayCapability[]) {
  const origins: string[] = [];
  for (const relay of relays) {
    if (!relaySupportsWebSocket(relay.transports ?? [])) {
      continue;
    }
    for (const endpoint of relay.endpointOrigins ?? []) {
      const origin = normalizeBackendOrigin(endpoint);
      if (origin && !origins.includes(origin)) {
        origins.push(origin);
      }
    }
  }
  return origins;
}

export function toWebSocketUrl(origin: string) {
  return `${toWebSocketOrigin(origin)}/ws`;
}

export async function resolveWebSocketUrls(origins = appConfig.backendOrigins) {
  const expanded = [...origins];
  for (const origin of origins) {
    if (expanded.length >= MAX_DISCOVERED_ORIGINS) {
      break;
    }

    try {
      const response = await fetchWithTimeout(
        `${origin}/bootstrap`,
        undefined,
        { timeoutMs: BOOTSTRAP_TIMEOUT_MS }
      );
      if (!response.ok) {
        continue;
      }
      const body = await response.json() as BootstrapResponse;
      for (const endpoint of relayEndpointOrigins(body.relays ?? [])) {
        if (expanded.length >= MAX_DISCOVERED_ORIGINS) {
          break;
        }
        if (!expanded.includes(endpoint)) {
          expanded.push(endpoint);
        }
      }
    } catch (error) {
      console.warn(`Bootstrap discovery failed for ${origin}`, error);
    }
  }

  return expanded.map(toWebSocketUrl);
}

function relaySupportsWebSocket(transports: string[]) {
  return transports.some((transport) => {
    const normalized = transport.trim().toLowerCase();
    return normalized === 'central_ws' || normalized === 'fallback_wss';
  });
}

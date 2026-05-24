import { fetchWithTimeout, toNetworkErrorMessage } from './http';
import { WIRE_PROTOCOL_VERSION } from './protocolContract';

const PROTOCOL_REQUEST_TIMEOUT_MS = 4_000;

export type ProtocolCompatibilityDescriptor = {
  protocolVersion?: unknown;
  requiredClientStateVersion?: unknown;
  supportedClientStateVersions?: unknown;
};

export type ProtocolCompatibilityResult = {
  compatible: boolean;
  message: string;
};

export function protocolEndpointForWebSocketUrl(webSocketUrl: string) {
  const parsed = new URL(webSocketUrl);
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  parsed.pathname = '/protocol';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function assessProtocolCompatibility(
  descriptor: ProtocolCompatibilityDescriptor,
  localClientStateVersion: string
): ProtocolCompatibilityResult {
  if (descriptor.protocolVersion !== WIRE_PROTOCOL_VERSION) {
    return {
      compatible: false,
      message: 'This server uses an incompatible protocol version. Update Messk or use a compatible server.',
    };
  }
  const supported = Array.isArray(descriptor.supportedClientStateVersions)
    ? descriptor.supportedClientStateVersions.filter((value): value is string => typeof value === 'string')
    : [];
  if (!supported.includes(localClientStateVersion)) {
    return {
      compatible: false,
      message: 'This Messk build is no longer supported by the server. Install the current release before reconnecting.',
    };
  }
  return { compatible: true, message: '' };
}

export async function verifyWebSocketProtocol(
  webSocketUrl: string,
  localClientStateVersion: string
): Promise<ProtocolCompatibilityResult> {
  try {
    const response = await fetchWithTimeout(
      protocolEndpointForWebSocketUrl(webSocketUrl),
      undefined,
      { timeoutMs: PROTOCOL_REQUEST_TIMEOUT_MS }
    );
    if (!response.ok) {
      return {
        compatible: false,
        message: 'Unable to verify server compatibility. The server must be upgraded before this client can connect.',
      };
    }
    return assessProtocolCompatibility(await response.json() as ProtocolCompatibilityDescriptor, localClientStateVersion);
  } catch (error) {
    return {
      compatible: false,
      message: `Unable to verify server compatibility. ${toNetworkErrorMessage(error)}`,
    };
  }
}

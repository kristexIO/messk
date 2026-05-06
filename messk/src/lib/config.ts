const DEFAULT_BACKEND_ORIGIN = 'http://localhost:8080';
const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:global.stun.twilio.com:3478',
];

function normalizeOrigin(value: string | undefined | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\/+$/, '');
}

function tryParseUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  const parsed = tryParseUrl(origin);
  return parsed ? isLoopbackHost(parsed.hostname) : false;
}

function getBrowserHttpOrigin(): string | undefined {
  if (typeof window === 'undefined' || !window.location.origin || window.location.origin === 'null') {
    return undefined;
  }
  const origin = normalizeOrigin(window.location.origin);
  const parsed = tryParseUrl(origin);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return undefined;
  }
  return parsed.origin;
}

function resolveBackendOrigin() {
  const configured = normalizeOrigin(import.meta.env.VITE_BACKEND_URL as string | undefined);
  const browserOrigin = getBrowserHttpOrigin();

  if (configured) {
    if (browserOrigin && isLoopbackOrigin(configured) && !isLoopbackOrigin(browserOrigin)) {
      return browserOrigin;
    }
    return configured;
  }

  return browserOrigin || DEFAULT_BACKEND_ORIGIN;
}

function parseRtcUrlList(value: string | undefined, fallback: string[] = []): string[] {
  const raw = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return raw && raw.length > 0 ? raw : fallback;
}

function toWebSocketOrigin(origin: string): string {
  if (origin.startsWith('https://')) {
    return `wss://${origin.slice('https://'.length)}`;
  }
  if (origin.startsWith('http://')) {
    return `ws://${origin.slice('http://'.length)}`;
  }
  return origin;
}

const backendOrigin = resolveBackendOrigin();
const stunUrls = parseRtcUrlList(import.meta.env.VITE_STUN_URLS as string | undefined, DEFAULT_STUN_URLS);
const turnUrls = parseRtcUrlList(import.meta.env.VITE_TURN_URLS as string | undefined);
const turnUsername = (import.meta.env.VITE_TURN_USERNAME as string | undefined)?.trim() || '';
const turnCredential = (import.meta.env.VITE_TURN_CREDENTIAL as string | undefined)?.trim() || '';

const rtcIceServers: RTCIceServer[] = [
  ...stunUrls.map((urls) => ({ urls })),
  ...(turnUrls.length > 0 && turnUsername && turnCredential
    ? [{ urls: turnUrls, username: turnUsername, credential: turnCredential }]
    : []),
];

export const appConfig = {
  backendOrigin,
  wsUrl: `${toWebSocketOrigin(backendOrigin)}/ws`,
  uploadUrl: `${backendOrigin}/upload`,
  profileUrl: `${backendOrigin}/profile`,
  rtcIceServers,
  rtcRelayConfigured: turnUrls.length > 0 && Boolean(turnUsername && turnCredential),
};

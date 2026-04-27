const configuredBackendOrigin = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/+$/, '');
const fallbackBrowserOrigin =
  typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null'
    ? window.location.origin.replace(/\/+$/, '')
    : undefined;
const backendOrigin = configuredBackendOrigin || fallbackBrowserOrigin || 'http://localhost:8080';

function toWebSocketOrigin(origin: string): string {
  if (origin.startsWith('https://')) {
    return `wss://${origin.slice('https://'.length)}`;
  }
  if (origin.startsWith('http://')) {
    return `ws://${origin.slice('http://'.length)}`;
  }
  return origin;
}

export const appConfig = {
  backendOrigin,
  wsUrl: `${toWebSocketOrigin(backendOrigin)}/ws`,
  uploadUrl: `${backendOrigin}/upload`,
  profileUrl: `${backendOrigin}/profile`,
};

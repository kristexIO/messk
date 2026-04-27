export class HttpRequestError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
  }
}

type FetchWithTimeoutOptions = {
  timeoutMs?: number;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const UPLOAD_REQUEST_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchWithTimeoutOptions
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
    }
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpRequestError('The server took too long to respond. Please try again.');
    }
    if (error instanceof TypeError) {
      throw new HttpRequestError('Unable to reach the server. Check your connection and try again.');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    if (upstreamSignal) {
      upstreamSignal.removeEventListener('abort', abortFromUpstream);
    }
  }
}

export function toNetworkErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.'
) {
  if (error instanceof HttpRequestError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

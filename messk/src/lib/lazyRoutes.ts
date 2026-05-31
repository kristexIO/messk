export type LazyRouteId = 'auth' | 'chat' | 'session' | 'trust';

export type LazyRouteCopy = {
  title: string;
  detail: string;
  ariaLabel: string;
};

export type LazyRouteBudget = {
  id: LazyRouteId | 'entry';
  chunkName: string;
  maxBytes: number;
  reason: string;
};

export const lazyRouteCopies: Record<LazyRouteId, LazyRouteCopy> = {
  auth: {
    title: 'Loading secure sign in',
    detail: 'Preparing the local identity screen.',
    ariaLabel: 'Loading secure sign in',
  },
  chat: {
    title: 'Loading chat workspace',
    detail: 'Preparing encrypted conversations and local state.',
    ariaLabel: 'Loading chat workspace',
  },
  session: {
    title: 'Restoring session',
    detail: 'Checking local device state before opening the workspace.',
    ariaLabel: 'Restoring local session',
  },
  trust: {
    title: 'Loading trust center',
    detail: 'Opening public security and privacy disclosures.',
    ariaLabel: 'Loading trust center',
  },
};

export const lazyRouteBudgets: readonly LazyRouteBudget[] = [
  {
    id: 'entry',
    chunkName: 'index',
    maxBytes: 200_000,
    reason: 'The first app shell should stay small enough to render route fallbacks quickly.',
  },
  {
    id: 'auth',
    chunkName: 'Auth',
    maxBytes: 80_000,
    reason: 'Sign-in should not pull the full chat workspace.',
  },
  {
    id: 'chat',
    chunkName: 'Chat',
    maxBytes: 260_000,
    reason: 'Chat is the heavy route, but should remain isolated from first paint.',
  },
  {
    id: 'session',
    chunkName: 'AuthenticatedSession',
    maxBytes: 160_000,
    reason: 'Authenticated boot logic should be isolated from public routes.',
  },
  {
    id: 'trust',
    chunkName: 'TrustCenter',
    maxBytes: 40_000,
    reason: 'The public trust route should stay readable without loading chat.',
  },
];

export function getLazyRouteCopy(route: LazyRouteId): LazyRouteCopy {
  return lazyRouteCopies[route];
}


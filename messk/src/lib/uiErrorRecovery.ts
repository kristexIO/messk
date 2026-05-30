export type UiErrorScope = 'app' | 'chat-surface';

export type SafeUiErrorReport = {
  scope: UiErrorScope;
  errorName: string;
  componentStack?: string;
};

export type UiRecoveryCopy = {
  title: string;
  body: string;
  primaryAction: string;
  secondaryAction?: string;
};

const MAX_COMPONENT_STACK_LENGTH = 600;
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_. -]{0,80}$/;

function toSafeErrorName(error: unknown) {
  const candidate = error instanceof Error ? error.name : typeof error;
  if (SAFE_ERROR_NAME_PATTERN.test(candidate)) {
    return candidate;
  }
  return 'UnknownError';
}

function toSafeComponentStack(componentStack?: string) {
  if (!componentStack) {
    return undefined;
  }
  return componentStack.slice(0, MAX_COMPONENT_STACK_LENGTH);
}

export function getSafeUiErrorReport(
  scope: UiErrorScope,
  error: unknown,
  componentStack?: string
): SafeUiErrorReport {
  const safeStack = toSafeComponentStack(componentStack);
  return {
    scope,
    errorName: toSafeErrorName(error),
    ...(safeStack ? { componentStack: safeStack } : {}),
  };
}

export function getSafeUiRecoveryCopy(scope: UiErrorScope): UiRecoveryCopy {
  if (scope === 'chat-surface') {
    return {
      title: 'Chat recovered',
      body: 'This conversation view hit a local rendering error. Message text, keys, and raw diagnostics stay hidden.',
      primaryAction: 'Try again',
      secondaryAction: 'Back to chats',
    };
  }

  return {
    title: 'Interface recovered',
    body: 'A local interface error was contained. Reloading keeps your account data and reconnects the chat.',
    primaryAction: 'Reload',
    secondaryAction: 'Try again',
  };
}

export function logUiRenderError(scope: UiErrorScope, error: unknown, componentStack?: string) {
  console.error('UI render error', getSafeUiErrorReport(scope, error, componentStack));
}

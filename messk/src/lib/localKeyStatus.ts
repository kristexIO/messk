export type LocalKeyStatusInput = {
  hasUnlockedIdentity: boolean;
  hasPin: boolean;
  isIdentityRemembered: boolean;
  autoLockMinutes: number;
  databaseName: string;
};

export type LocalKeyStatusItem = {
  id: 'identity' | 'pin' | 'restore' | 'database' | 'autolock';
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'neutral';
  detail: string;
};

function formatDatabaseScope(databaseName: string): string {
  if (!databaseName.includes('-')) {
    return 'Default local vault';
  }

  const suffix = databaseName.slice(-8);
  return `Identity-scoped vault (...${suffix})`;
}

export function buildLocalKeyStatus(input: LocalKeyStatusInput): LocalKeyStatusItem[] {
  return [
    {
      id: 'identity',
      label: 'Identity key',
      value: input.hasUnlockedIdentity ? 'Unlocked in memory' : 'Locked or not loaded',
      tone: input.hasUnlockedIdentity ? 'ok' : 'warn',
      detail: 'The seed phrase and raw secret are not shown here. Lock or panic reset this browser if the device is shared.',
    },
    {
      id: 'pin',
      label: 'PIN lock',
      value: input.hasPin ? 'Enabled' : 'Disabled',
      tone: input.hasPin ? 'ok' : 'warn',
      detail: input.hasPin
        ? 'Auto-lock can protect the current browser session after inactivity.'
        : 'Set a PIN before relying on local session protection.',
    },
    {
      id: 'restore',
      label: 'Device restore',
      value: input.isIdentityRemembered ? 'PIN restore ready' : 'Seed required on restart',
      tone: input.isIdentityRemembered ? 'ok' : 'neutral',
      detail: input.isIdentityRemembered
        ? 'An encrypted identity envelope is stored locally and requires the PIN.'
        : 'This browser will need the seed phrase again after restart or panic reset.',
    },
    {
      id: 'database',
      label: 'Local database',
      value: formatDatabaseScope(input.databaseName),
      tone: 'neutral',
      detail: 'Local message, contact and session records are scoped to this browser profile.',
    },
    {
      id: 'autolock',
      label: 'Auto-lock',
      value: input.autoLockMinutes > 0 ? `${input.autoLockMinutes} minutes` : 'Disabled',
      tone: input.autoLockMinutes > 0 ? 'ok' : 'warn',
      detail: input.autoLockMinutes > 0
        ? 'The app locks after inactivity while a PIN is configured.'
        : 'No inactivity lock is configured.',
    },
  ];
}

let _permissionGranted = false;

/**
 * Initialize notification permissions. Call once on app startup.
 */
export async function initNotifications(): Promise<void> {
  if (!('Notification' in window)) return;
  try {
    _permissionGranted = Notification.permission === 'granted';
    if (!_permissionGranted && Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      _permissionGranted = permission === 'granted';
    }
  } catch (e) {
    console.warn('Notifications not available:', e);
  }
}

/**
 * Send a native desktop notification.
 * Only shows if the user has granted permission and the app might be in background.
 */
export function sendDesktopNotification(title: string, body: string): void {
  if (!_permissionGranted || !('Notification' in window)) return;

  // Don't notify if the window has focus
  if (document.hasFocus()) return;

  try {
    new Notification(title, { body });
  } catch (e) {
    console.warn('Failed to send notification:', e);
  }
}

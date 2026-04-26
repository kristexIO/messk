import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

// Check if we're running in Tauri (desktop) or browser
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let _permissionGranted = false;

/**
 * Initialize notification permissions. Call once on app startup.
 */
export async function initNotifications(): Promise<void> {
  if (!isTauri) return;
  try {
    _permissionGranted = await isPermissionGranted();
    if (!_permissionGranted) {
      const permission = await requestPermission();
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
  if (!isTauri || !_permissionGranted) return;

  // Don't notify if the window has focus
  if (document.hasFocus()) return;

  try {
    sendNotification({ title, body });
  } catch (e) {
    console.warn('Failed to send notification:', e);
  }
}

# Messk Mobile

Separate native mobile project for the future Messk Android and iPhone apps.

## Goals

- Mobile-first architecture from scratch
- No Tauri dependency
- Security-first defaults
- Clean path toward Android APK and iPhone builds

## Current foundation

- Flutter stable project
- Secure device identity bootstrap
- Secure storage wrapper
- Backend config via `--dart-define`
- HTTP health probe foundation
- WebSocket client foundation

## Run locally

```powershell
cd C:\a\messan\messkapk
C:\Users\kananci\Desktop\flutter\bin\flutter run
```

## Build targets

### Android APK

Requires Android SDK and `flutter doctor` to show Android toolchain as healthy.

```powershell
C:\Users\kananci\Desktop\flutter\bin\flutter build apk --release
```

### iPhone

Requires macOS + Xcode.

```bash
flutter build ios --release
```

## Runtime configuration

Defaults:

- API: `https://messk.online`
- WebSocket: `wss://messk.online/ws`

Override example:

```powershell
C:\Users\kananci\Desktop\flutter\bin\flutter run --dart-define=MESSK_API_BASE=https://messk.online --dart-define=MESSK_ENV=production
```

## Next milestones

1. Add Android SDK and generate the first debug APK.
2. Replace placeholder device identity with the real messenger key lifecycle.
3. Add encrypted local database for messages and sessions.
4. Implement backend auth, session bootstrap, and realtime sync.
5. Add push notifications, media, and release signing.

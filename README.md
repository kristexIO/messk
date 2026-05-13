# Messk

End-to-end encrypted messenger workspace.

## Structure

- `mess/` - Go backend and HTTP/WebSocket protocol source of truth.
- `messk/` - browser client kept as the web product and protocol reference.
- `clients/windows/` - native Rust Windows client, no WebView/Tauri/Electron shell.
- `scripts/` - local build, smoke, release, and VPS deployment helpers.
- `docs/` - architecture and client direction notes.

## Local Checks

```powershell
cd mess
go test ./...
go build ./...

cd ..\messk
npm ci
npm run lint
npm test
npm run build

cd ..\clients\windows
cargo fmt --check
cargo test
cargo build
```

For a direct Windows client build from the repository root:

```powershell
.\scripts\build-windows-client.ps1 -Configuration debug
```

## Cleanup Policy

Legacy Flutter and Tauri/WebView clients were removed. Runtime databases, uploads,
logs, frontend `dist`, Node modules, and Rust `target` directories stay ignored.

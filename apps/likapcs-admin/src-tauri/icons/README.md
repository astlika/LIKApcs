# Icons

Tauri requires `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` and `icon.ico` here.
Generate them from a 1024×1024 source image with:

```bash
pnpm --filter @likapcs/admin tauri icon path/to/likapcs-icon.png
```

Placeholder PNG icons are committed so the project builds; replace them with the final brand icon.

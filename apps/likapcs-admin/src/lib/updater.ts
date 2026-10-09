/**
 * In-app updates for the installed desktop application.
 *
 * The Tauri updater plugin fetches `latest.json` from the GitHub release feed configured in
 * `src-tauri/tauri.conf.json`, verifies the installer's minisign signature against the public key
 * compiled into the app, runs the installer and relaunches. In the browser/dev build none of this
 * exists, so every function here degrades gracefully (`isDesktopApp()` is false).
 */

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  notes?: string;
  /** Downloads + installs the update; resolves when the installer has finished. */
  install: (onProgress: (downloaded: number, total: number | null) => void) => Promise<void>;
  /** Release the Rust-side handle when the user dismisses the update. */
  dismiss: () => Promise<void>;
}

export const GITHUB_RELEASES_URL = 'https://github.com/astlika/LIKApcs/releases';

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Returns the available update or null when the running version is the latest. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isDesktopApp()) throw new Error('updates_unavailable_in_browser');
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: 15_000 });
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    notes: update.body,
    install: async (onProgress) => {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? null;
        else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          onProgress(downloaded, total);
        } else if (event.event === 'Finished') onProgress(total ?? downloaded, total);
      });
    },
    dismiss: () => update.close(),
  };
}

/** Restart the application (used after a successful install when the installer did not do it). */
export async function relaunchApp(): Promise<void> {
  if (!isDesktopApp()) return;
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

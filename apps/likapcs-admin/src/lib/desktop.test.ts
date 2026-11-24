import { afterEach, describe, expect, it, vi } from 'vitest';
import { canShowServerFolders, joinServerPath, showInFolder } from './desktop';

describe('joinServerPath', () => {
  it('uses the separator the folder already has', () => {
    expect(
      joinServerPath(
        'C:\\Users\\Arben Lika\\AppData\\Local\\LIKApcs-Data\\backups',
        'likapcs-manual-20261124-213000.likapcs-backup.json',
      ),
    ).toBe(
      'C:\\Users\\Arben Lika\\AppData\\Local\\LIKApcs-Data\\backups\\likapcs-manual-20261124-213000.likapcs-backup.json',
    );
    expect(joinServerPath('/var/lib/likapcs/backups', 'a.json')).toBe(
      '/var/lib/likapcs/backups/a.json',
    );
  });

  it('does not double a separator the folder ends with', () => {
    expect(joinServerPath('D:\\Kopje\\', 'a.json')).toBe('D:\\Kopje\\a.json');
    expect(joinServerPath('/mnt/usb/', 'a.json')).toBe('/mnt/usb/a.json');
  });
});

describe('opening a folder of the server (0.41.0)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is offered only in the desktop app, with the server on this same PC', () => {
    // A browser: nothing of the server can be opened from here.
    expect(canShowServerFolders('http://127.0.0.1:4700')).toBe(false);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(canShowServerFolders('http://127.0.0.1:4700')).toBe(true);
    expect(canShowServerFolders('http://localhost:4700')).toBe(true);
    expect(canShowServerFolders('http://LOCALHOST:4700/')).toBe(true);
    // The Admin of a second PC: the folder is on the main PC, not here.
    expect(canShowServerFolders('http://192.168.1.20:4700')).toBe(false);
    expect(canShowServerFolders('http://kasa.local:4700')).toBe(false);
    expect(canShowServerFolders('')).toBe(false);
    expect(canShowServerFolders('not a url')).toBe(false);
  });

  it('answers false in a browser instead of failing', async () => {
    expect(await showInFolder('C:\\Kopje')).toBe(false);
  });
});

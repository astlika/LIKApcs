import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveKindOf,
  BACKUP_SHARES,
  backupCheckingPercent,
  backupJobPercent,
  backupSavingPercent,
  DEFAULT_BACKUP_FILE_FORMAT,
  rememberBackupFormat,
  rememberedBackupFormat,
  RESTORE_SHARES,
  restoreJobPercent,
  restoreUploadPercent,
  safeUploadName,
  suggestedBackupName,
  tooLargeForFat32,
} from './backup-file';

describe('archiveKindOf', () => {
  const bytes = (...values: number[]) => new Blob([new Uint8Array(values)]);

  it('knows an encrypted LIKApcs archive by its first eight bytes', async () => {
    const file = new Blob([new TextEncoder().encode('LKPBENC1'), new Uint8Array(64)]);
    expect(await archiveKindOf(file)).toBe('encrypted');
  });

  it('knows a plain archive by the gzip signature', async () => {
    expect(await archiveKindOf(bytes(0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3))).toBe('plain');
  });

  it('knows a backup written as a JSON document by how it begins (0.41.0)', async () => {
    const head = '{"format":"likapcs-backup-json","formatVersion":1,\n"readme":"…",\n';
    expect(await archiveKindOf(new Blob([head]))).toBe('plain');
    // Saved again by a Windows tool: a mark in front, other line ends.
    expect(await archiveKindOf(new Blob(['\uFEFF', head.replace(/\n/g, '\r\n')]))).toBe('plain');
    // Laid out differently by another program: the server says what is wrong with it.
    expect(await archiveKindOf(new Blob(['{\n  "format": "likapcs-backup-json",\n']))).toBe(
      'plain',
    );
    // Other JSON is not a backup: the data file made for an AI, a settings file.
    expect(await archiveKindOf(new Blob(['{"format":"likapcs-data","version":3}']))).toBe(
      'unknown',
    );
    expect(await archiveKindOf(new Blob(['{"hello":"world"}']))).toBe('unknown');
    expect(await archiveKindOf(new Blob(['[1,2,3]']))).toBe('unknown');
  });

  it('says "unknown" for anything else, and for a file too short to tell', async () => {
    expect(await archiveKindOf(new Blob(['%PDF-1.4 not a backup']))).toBe('unknown');
    expect(await archiveKindOf(new Blob(['LKPBENC']))).toBe('unknown');
    expect(await archiveKindOf(bytes(0x1f))).toBe('unknown');
    expect(await archiveKindOf(new Blob([]))).toBe('unknown');
  });
});

describe('safeUploadName', () => {
  it('leaves the names this program writes as they are', () => {
    const name = 'likapcs-manual-20261121-223313.likapcs-backup.tar.gz.enc';
    expect(safeUploadName(name)).toBe(name);
  });

  it('replaces spaces, brackets and letters outside A–Z with a dash', () => {
    expect(safeUploadName('Kopja e dyqanit (1).likapcs-backup.tar.gz')).toBe(
      'Kopja-e-dyqanit-1-.likapcs-backup.tar.gz',
    );
    expect(safeUploadName('kopje ë ç.tar.gz')).toMatch(/^[A-Za-z0-9._-]+\.tar\.gz$/);
  });

  it('never starts with a dot or a dash and is never empty', () => {
    expect(safeUploadName('..\\..\\x.tar.gz')).toBe('x.tar.gz');
    expect(safeUploadName('-- .tar.gz')).toBe('tar.gz');
    expect(safeUploadName('   ')).toBe('backup');
    expect(safeUploadName('')).toBe('backup');
  });

  it('keeps the END of a long name: the extension tells the kinds of archive apart', () => {
    const name = `${'a'.repeat(300)}.likapcs-backup.tar.gz.enc`;
    const safe = safeUploadName(name);
    expect(safe).toHaveLength(160);
    expect(safe.endsWith('.likapcs-backup.tar.gz.enc')).toBe(true);
  });
});

describe('suggestedBackupName', () => {
  it('carries the local date and time, and ".enc" when the file has a password', () => {
    const at = new Date(2026, 10, 21, 9, 5);
    expect(suggestedBackupName(at, false)).toBe(
      'LIKApcs-backup-20261121-0905.likapcs-backup.tar.gz',
    );
    expect(suggestedBackupName(at, true)).toBe(
      'LIKApcs-backup-20261121-0905.likapcs-backup.tar.gz.enc',
    );
  });

  it('ends in .json for a backup written as a JSON document (0.41.0)', () => {
    const at = new Date(2026, 10, 24, 21, 30);
    expect(suggestedBackupName(at, false, 'json')).toBe(
      'LIKApcs-backup-20261124-2130.likapcs-backup.json',
    );
    expect(suggestedBackupName(at, true, 'json')).toBe(
      'LIKApcs-backup-20261124-2130.likapcs-backup.json.enc',
    );
    expect(suggestedBackupName(at, false, 'archive')).toBe(suggestedBackupName(at, false));
    // The upload accepts these names as they are.
    expect(safeUploadName(suggestedBackupName(at, true, 'json'))).toBe(
      suggestedBackupName(at, true, 'json'),
    );
  });
});

describe('the kind of file «Backup file» makes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is JSON until the owner chooses, then what was chosen last', () => {
    // The tests run without a browser: a storage that keeps what it is given stands in for it.
    const kept = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
      },
    });
    expect(DEFAULT_BACKUP_FILE_FORMAT).toBe('json');
    expect(rememberedBackupFormat()).toBe('json');
    rememberBackupFormat('archive');
    expect(kept.get('likapcs.backupFileFormat')).toBe('archive');
    expect(rememberedBackupFormat()).toBe('archive');
    rememberBackupFormat('json');
    expect(rememberedBackupFormat()).toBe('json');
    // Something else in the storage is not a choice.
    kept.set('likapcs.backupFileFormat', 'zip');
    expect(rememberedBackupFormat()).toBe('json');
  });

  it('is JSON where nothing can be remembered', () => {
    expect(rememberedBackupFormat()).toBe('json');
    expect(() => rememberBackupFormat('archive')).not.toThrow();
  });
});

describe('a file a FAT32 USB stick cannot hold', () => {
  it('warns only above 4 GB less one byte', () => {
    const limit = 4 * 1024 ** 3 - 1;
    expect(tooLargeForFat32(limit)).toBe(false);
    expect(tooLargeForFat32(limit + 1)).toBe(true);
    expect(tooLargeForFat32(612_500_000)).toBe(false);
    expect(tooLargeForFat32(9 * 1024 ** 3)).toBe(true);
  });

  it('stays quiet when the size is not known', () => {
    expect(tooLargeForFat32(null)).toBe(false);
    expect(tooLargeForFat32(undefined)).toBe(false);
  });
});

describe('one bar for several steps', () => {
  it('the shares add up to the whole bar', () => {
    expect(BACKUP_SHARES.job + BACKUP_SHARES.saving + BACKUP_SHARES.checking).toBe(100);
    expect(RESTORE_SHARES.upload + RESTORE_SHARES.job).toBe(100);
  });

  it('a backup that is also saved elsewhere: job, then the copy, then reading it back', () => {
    const steps = [
      backupJobPercent(0, true),
      backupJobPercent(50, true),
      backupJobPercent(100, true),
      backupSavingPercent(0),
      backupSavingPercent(0.5),
      backupSavingPercent(1),
      backupCheckingPercent(0),
      backupCheckingPercent(0.5),
      backupCheckingPercent(1),
    ];
    expect(steps[0]).toBe(0);
    expect(steps[2]).toBe(BACKUP_SHARES.job);
    expect(steps[5]).toBe(BACKUP_SHARES.job + BACKUP_SHARES.saving);
    // Never backwards, and 100 is left for the moment the checksum was compared.
    for (let i = 1; i < steps.length; i += 1)
      expect(steps[i]!).toBeGreaterThanOrEqual(steps[i - 1]!);
    expect(steps[steps.length - 1]).toBe(99);
  });

  it('a backup that stays on the main PC uses the whole bar for the job', () => {
    expect(backupJobPercent(37, false)).toBe(37);
    expect(backupJobPercent(250, false)).toBe(100);
    expect(backupJobPercent(-5, false)).toBe(0);
  });

  it('a restore from a file: sending it, then the job; 100 only when the job says so', () => {
    expect(restoreUploadPercent(0, 1000)).toBe(0);
    expect(restoreUploadPercent(500, 1000)).toBe(Math.floor(RESTORE_SHARES.upload / 2));
    expect(restoreUploadPercent(1000, 1000)).toBe(RESTORE_SHARES.upload);
    expect(restoreUploadPercent(10, 0)).toBe(0);
    expect(restoreJobPercent(0, true)).toBe(RESTORE_SHARES.upload);
    expect(restoreJobPercent(99, true)).toBeLessThan(100);
    expect(restoreJobPercent(100, true)).toBe(100);
    // An archive that is already in the list: nothing is sent, the job is the whole bar.
    expect(restoreJobPercent(42, false)).toBe(42);
  });
});

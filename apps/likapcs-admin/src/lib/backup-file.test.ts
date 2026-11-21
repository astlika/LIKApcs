import { describe, expect, it } from 'vitest';
import {
  archiveKindOf,
  BACKUP_SHARES,
  backupCheckingPercent,
  backupJobPercent,
  backupSavingPercent,
  RESTORE_SHARES,
  restoreJobPercent,
  restoreUploadPercent,
  safeUploadName,
  suggestedBackupName,
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

import { describe, expect, it } from 'vitest';
import { isDangerousFile } from './dangerousFiles.ts';

describe('isDangerousFile', () => {
  it('flags native executables and installers', () => {
    for (const name of [
      'setup.exe',
      'app.msi',
      'game.dmg',
      'pkg.pkg',
      'tool.deb',
      'rom.apk',
    ]) {
      expect(isDangerousFile(name)).toBe(true);
    }
  });

  it('flags scripts and scriptable shells', () => {
    for (const name of [
      'run.sh',
      'deploy.ps1',
      'macro.vbs',
      'applet.jar',
      'evil.js',
      'task.bat',
    ]) {
      expect(isDangerousFile(name)).toBe(true);
    }
  });

  it('flags macro-enabled Office documents but not their plain counterparts', () => {
    expect(isDangerousFile('budget.xlsm')).toBe(true);
    expect(isDangerousFile('deck.pptm')).toBe(true);
    expect(isDangerousFile('budget.xlsx')).toBe(false);
    expect(isDangerousFile('report.docx')).toBe(false);
  });

  it('flags archives, which can conceal executables', () => {
    for (const name of [
      'bundle.zip',
      'files.7z',
      'dump.gz',
      'backup.tar',
      'data.rar',
    ]) {
      expect(isDangerousFile(name)).toBe(true);
    }
  });

  it('does not flag plain data, document, or media files', () => {
    for (const name of [
      'report.csv',
      'notes.txt',
      'photo.png',
      'clip.mp4',
      'song.mp3',
      'doc.pdf',
      'logo.svg',
    ]) {
      expect(isDangerousFile(name)).toBe(false);
    }
  });

  it('matches the final extension on double extensions', () => {
    expect(isDangerousFile('invoice.pdf.exe')).toBe(true);
    expect(isDangerousFile('photo.exe.png')).toBe(false);
    expect(isDangerousFile('archive.tar.gz')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isDangerousFile('SETUP.EXE')).toBe(true);
    expect(isDangerousFile('Run.Sh')).toBe(true);
    expect(isDangerousFile('  installer.msi  ')).toBe(true);
  });

  it('does not flag files without a real extension', () => {
    expect(isDangerousFile('README')).toBe(false);
    expect(isDangerousFile('.bashrc')).toBe(false);
    expect(isDangerousFile('archive.')).toBe(false);
    expect(isDangerousFile('')).toBe(false);
  });
});

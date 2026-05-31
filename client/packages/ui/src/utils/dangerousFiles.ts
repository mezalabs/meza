/**
 * Detects file types that warrant a "potentially dangerous download" warning
 * before the user opens them.
 *
 * Scope (chosen deliberately): code-execution-capable types — native
 * executables, installers, scripts, macro-enabled Office documents, OS
 * shortcuts, mountable disk images — PLUS archives, which routinely carry
 * executables inside them. Plain data and document formats (.csv, .docx,
 * .txt, images, audio, video, .pdf) are NOT flagged: they cannot run code on
 * their own, and warning on them would only train users to click through.
 *
 * This is a client-side UX nudge, not a security boundary — chat attachments
 * are E2EE so the server can't inspect them, and `accept=` was removed from the
 * composer for the same reason. The warning helps recipients make an informed
 * choice; it does not (and cannot) prevent a determined user from downloading.
 */
const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows executables, installers & scriptable shells
  'exe',
  'msi',
  'msix',
  'msp',
  'com',
  'scr',
  'pif',
  'cpl',
  'gadget',
  'bat',
  'cmd',
  'hta',
  'reg',
  'lnk',
  'scf',
  'inf',
  'msc',
  'jnlp',
  // Libraries / drivers
  'dll',
  'sys',
  'drv',
  'ocx',
  // macOS
  'app',
  'dmg',
  'pkg',
  'mpkg',
  'command',
  'action',
  'workflow',
  'terminal',
  // Linux / Unix
  'deb',
  'rpm',
  'run',
  'appimage',
  'bin',
  'out',
  'ko',
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  // Mobile
  'apk',
  'apks',
  'xapk',
  'ipa',
  // Cross-platform runtimes & scripts
  'jar',
  'js',
  'jse',
  'vbs',
  'vbe',
  'vb',
  'wsf',
  'wsh',
  'wsc',
  'ws',
  'ps1',
  'ps1xml',
  'ps2',
  'psc1',
  'psc2',
  // Macro-enabled Office documents
  'docm',
  'dotm',
  'xlsm',
  'xltm',
  'xlam',
  'pptm',
  'potm',
  'ppam',
  // Mountable disk images
  'iso',
  'img',
  'vhd',
  'vhdx',
  // Archives — may conceal any of the above
  'zip',
  'rar',
  '7z',
  'gz',
  'tgz',
  'tar',
  'bz2',
  'tbz2',
  'xz',
  'txz',
  'zst',
  'lz',
  'lzma',
  'lz4',
  'cab',
  'arj',
  'ace',
  'z',
]);

/**
 * The lowercased final extension of `filename` (no leading dot), or `''` when
 * there is none. Dotfiles like `.bashrc` and trailing-dot names return `''`.
 */
function fileExtension(filename: string): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return '';
  return trimmed.slice(dot + 1).toLowerCase();
}

/**
 * True when `filename` looks like a file that could run code — or conceal
 * something that does — and so should prompt a download confirmation.
 *
 * Matches on the final extension, so a double extension such as
 * `invoice.pdf.exe` is correctly flagged on its real `.exe` tail.
 */
export function isDangerousFile(filename: string): boolean {
  return DANGEROUS_EXTENSIONS.has(fileExtension(filename));
}

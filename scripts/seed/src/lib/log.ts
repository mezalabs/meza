const PREFIX = '\x1b[36m[seed]\x1b[0m';

export function log(msg: string) {
  console.log(`${PREFIX} ${msg}`);
}

export function logIndent(msg: string) {
  console.log(`${PREFIX}   ${msg}`);
}

export function logBlank() {
  console.log(PREFIX);
}

export function logError(msg: string) {
  console.error(`${PREFIX} \x1b[31mERROR:\x1b[0m ${msg}`);
}

export function logWarn(msg: string) {
  console.warn(`${PREFIX} \x1b[33mWARN:\x1b[0m ${msg}`);
}

export function logBox(lines: string[]) {
  const maxLen = Math.max(...lines.map((l) => l.length));
  const top = `\u250c${''.padEnd(maxLen + 2, '\u2500')}\u2510`;
  const bottom = `\u2514${''.padEnd(maxLen + 2, '\u2500')}\u2518`;

  console.log(`${PREFIX}`);
  console.log(`${PREFIX} ${top}`);
  for (const line of lines) {
    console.log(`${PREFIX} \u2502 ${line.padEnd(maxLen)} \u2502`);
  }
  console.log(`${PREFIX} ${bottom}`);
}

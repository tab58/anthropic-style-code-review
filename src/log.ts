/**
 * Makes text safe to print as one GitHub Actions log line. Actions parses lines that start with `::` (or the
 * legacy `##[`) as workflow commands, and log lines here can quote model-written text (titles, grep patterns).
 *
 * @param text - Any text; may contain newlines.
 * @returns The text on a single line (newlines shown as ` ⏎ `), with a leading space if it would start a command.
 */
export function actionsLine(text: string): string {
  const one = text.replace(/\s*\r?\n\s*/g, ' ⏎ ')
  return /^(::|##\[)/.test(one) ? ` ${one}` : one
}

/** Anchored, case-insensitive glob. Only * is special; all other characters are literal.
 * Dynamic programming avoids regex backtracking for untrusted command strings. */
export function matchesGlob(pattern: string, value: string): boolean {
  const text = Array.from(value.toLowerCase());
  let previous = Array<boolean>(text.length + 1).fill(false);
  previous[0] = true;
  for (const token of pattern.toLowerCase()) {
    const next = Array<boolean>(text.length + 1).fill(false);
    next[0] = token === "*" && previous[0];
    for (let index = 1; index <= text.length; index++) {
      next[index] = token === "*"
        ? previous[index] || next[index - 1]
        : previous[index - 1] && token === text[index - 1];
    }
    previous = next;
  }
  return previous[text.length];
}

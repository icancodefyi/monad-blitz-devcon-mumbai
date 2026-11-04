// Address poisoning: attackers create addresses that share the first and last
// characters of one you have paid, then plant them in your history so you
// copy the wrong one. Wallets usually show only those characters.

const PREFIX = 4; // hex characters after 0x
const SUFFIX = 4;

/** Returns the known address that `candidate` imitates, or null. */
export function lookalikeOf(candidate: string, known: Iterable<string>): string | null {
  const value = candidate.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) return null;
  for (const entry of known) {
    const other = entry.toLowerCase();
    if (other === value || !/^0x[0-9a-f]{40}$/.test(other)) continue;
    if (value.slice(2, 2 + PREFIX) === other.slice(2, 2 + PREFIX) && value.slice(-SUFFIX) === other.slice(-SUFFIX)) return other;
  }
  return null;
}

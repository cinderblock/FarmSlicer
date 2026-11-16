// Matching typed words against names (the command palette).

/** How well an entry named `label` matches the words typed, lower-cased
 *  (0 = not at all: every word must be somewhere). A word starting the
 *  name counts most, then one starting a word of it, then anywhere in it,
 *  then in the keywords. */
export function matchScore(words: string[], label: string, keywords = ""): number {
  if (words.length === 0) return 1;
  const name = label.toLowerCase();
  const all = `${name} ${keywords.toLowerCase()}`;
  let total = 0;
  for (const w of words) {
    if (name.startsWith(w)) total += 4;
    else if (name.split(/[\s/._-]+/).some((part) => part.startsWith(w))) total += 3;
    else if (name.includes(w)) total += 2;
    else if (all.includes(w)) total += 1;
    else return 0;
  }
  return total;
}

/** A palette query: plain words, and `label:` filters (`label:urgent`,
 *  `label:"needs review"`), lower-cased. `typingLabel` is a `label:`
 *  token still being typed (the query's last, with nothing after it):
 *  the palette offers label names to complete it. */
export interface PaletteQuery {
  words: string[];
  labels: string[];
  typingLabel: string | null;
}

const TOKEN = /label:"([^"]*)"?|label:(\S*)|(\S+)/gi;

export function parseQuery(query: string): PaletteQuery {
  const out: PaletteQuery = { words: [], labels: [], typingLabel: null };
  for (const m of query.matchAll(TOKEN)) {
    const quoted = m[1];
    const bare = m[2];
    if (quoted === undefined && bare === undefined) {
      out.words.push(m[3].toLowerCase());
      continue;
    }
    const text = (quoted ?? bare).trim().toLowerCase();
    const last = m.index + m[0].length === query.length;
    // Still typing it: an open quote, or a bare token at the very end.
    const open = quoted !== undefined ? !m[0].endsWith('"') || m[0] === 'label:"' : true;
    if (last && open) out.typingLabel = text;
    else if (text) out.labels.push(text);
  }
  if (out.typingLabel) out.labels.push(out.typingLabel);
  return out;
}

/** The labels a `label:` filter means: those named exactly that, else
 *  those whose name starts with it, else those with a word starting
 *  with it. */
export function labelsMatching<L extends { id: string; name: string }>(token: string, labels: L[]): L[] {
  const t = token.toLowerCase();
  const exact = labels.filter((l) => l.name.toLowerCase() === t);
  if (exact.length) return exact;
  const prefix = labels.filter((l) => l.name.toLowerCase().startsWith(t));
  if (prefix.length) return prefix;
  return labels.filter((l) => l.name.toLowerCase().split(/[\s/._-]+/).some((w) => w.startsWith(t)));
}

/** The query with its last `label:` token replaced by the whole label, ready for more. */
export function completeLabel(query: string, name: string): string {
  const token = /\s/.test(name) ? `label:"${name}"` : `label:${name}`;
  const at = query.toLowerCase().lastIndexOf("label:");
  return `${at < 0 ? query : query.slice(0, at)}${token} `;
}

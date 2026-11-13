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

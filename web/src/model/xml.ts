// A small, fast XML reader and writer for 3MF: model files run to millions
// of <vertex>/<triangle> elements, where DOMParser is slow (and missing in
// workers and Bun). Namespaces are not resolved: names come through with
// their prefix ("p:path", "slic3rpe:mmu_segmentation"). No DTDs, no
// entities beyond the predefined five and character references.

export interface XmlHandler {
  /** An element opens. `attrs` is reused between calls: copy what you keep. */
  open?(name: string, attrs: Attrs, selfClosing: boolean): void;
  close?(name: string): void;
  /** Character data between tags (entities decoded), CDATA included. */
  text?(text: string): void;
}

/** The attributes of the element being opened: a flat name/value list. */
export class Attrs {
  names: string[] = [];
  values: string[] = [];
  get length() {
    return this.names.length;
  }
  get(name: string): string | undefined {
    const i = this.names.indexOf(name);
    return i < 0 ? undefined : this.values[i];
  }
  /** By local name, whatever the prefix ("path" finds "p:path"). */
  getLocal(local: string): string | undefined {
    for (let i = 0; i < this.names.length; i++) {
      const n = this.names[i];
      if (n === local || (n.endsWith(local) && n.charCodeAt(n.length - local.length - 1) === 58 /* : */))
        return this.values[i];
    }
    return undefined;
  }
  clear() {
    this.names.length = 0;
    this.values.length = 0;
  }
  toObject(): Record<string, string> {
    const o: Record<string, string> = {};
    for (let i = 0; i < this.names.length; i++) o[this.names[i]] = this.values[i];
    return o;
  }
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[body] ?? whole;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`);
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Local name of a possibly prefixed name ("p:path" → "path"). */
export function localName(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}

/** Read `xml` start to end, calling `h`. Throws on malformed markup. */
export function parseXml(xml: string, h: XmlHandler): void {
  const attrs = new Attrs();
  const n = xml.length;
  let i = 0;
  // Skip a byte-order mark.
  if (xml.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (h.text) {
        const t = xml.slice(i);
        if (t.trim()) h.text(decodeEntities(t));
      }
      break;
    }
    if (lt > i && h.text) {
      const t = xml.slice(i, lt);
      if (t.trim()) h.text(decodeEntities(t));
    }
    const c = xml.charCodeAt(lt + 1);
    if (c === 63 /* ? */) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new Error("XML: unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (c === 33 /* ! */) {
      if (xml.startsWith("<!--", lt)) {
        const end = xml.indexOf("-->", lt + 4);
        if (end < 0) throw new Error("XML: unterminated comment");
        i = end + 3;
      } else if (xml.startsWith("<![CDATA[", lt)) {
        const end = xml.indexOf("]]>", lt + 9);
        if (end < 0) throw new Error("XML: unterminated CDATA");
        h.text?.(xml.slice(lt + 9, end));
        i = end + 3;
      } else {
        // <!DOCTYPE ...>: skipped (no internal subsets in 3MF).
        const end = xml.indexOf(">", lt + 2);
        if (end < 0) throw new Error("XML: unterminated declaration");
        i = end + 1;
      }
      continue;
    }
    if (c === 47 /* / */) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) throw new Error("XML: unterminated end tag");
      h.close?.(xml.slice(lt + 2, end).trim());
      i = end + 1;
      continue;
    }
    // Start tag: name, then attributes.
    let j = lt + 1;
    while (j < n) {
      const ch = xml.charCodeAt(j);
      if (isSpace(ch) || ch === 62 /* > */ || ch === 47 /* / */) break;
      j++;
    }
    const name = xml.slice(lt + 1, j);
    if (!name) throw new Error(`XML: empty tag name at ${lt}`);
    attrs.clear();
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (j >= n) throw new Error("XML: unterminated start tag");
      const ch = xml.charCodeAt(j);
      if (ch === 62 /* > */) {
        j++;
        break;
      }
      if (ch === 47 /* / */) {
        if (xml.charCodeAt(j + 1) !== 62) throw new Error(`XML: stray '/' in <${name}>`);
        selfClosing = true;
        j += 2;
        break;
      }
      const eq = xml.indexOf("=", j);
      if (eq < 0) throw new Error(`XML: attribute without value in <${name}>`);
      const attrName = xml.slice(j, eq).trim();
      let q = eq + 1;
      while (q < n && isSpace(xml.charCodeAt(q))) q++;
      const quote = xml.charCodeAt(q);
      if (quote !== 34 && quote !== 39) throw new Error(`XML: unquoted attribute ${attrName} in <${name}>`);
      const close = xml.indexOf(quote === 34 ? '"' : "'", q + 1);
      if (close < 0) throw new Error(`XML: unterminated attribute ${attrName} in <${name}>`);
      attrs.names.push(attrName);
      attrs.values.push(decodeEntities(xml.slice(q + 1, close)));
      j = close + 1;
    }
    h.open?.(name, attrs, selfClosing);
    if (selfClosing) h.close?.(name);
    i = j;
  }
}

/**
 * Builds a large XML document as chunks (one giant string concatenation
 * is slow and can exceed the engine's string limit).
 */
export class XmlWriter {
  private chunks: string[] = [];
  private buf = "";

  raw(s: string): this {
    this.buf += s;
    if (this.buf.length > 1 << 16) {
      this.chunks.push(this.buf);
      this.buf = "";
    }
    return this;
  }

  /** `<name a="1" b="2"` + (`/>` or `>`). Values are escaped; undefined skipped. */
  open(name: string, attrs: Record<string, string | number | undefined> = {}, selfClose = false): this {
    let s = `<${name}`;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      s += ` ${k}="${typeof v === "number" ? v : escapeXml(v)}"`;
    }
    return this.raw(s + (selfClose ? "/>\n" : ">\n"));
  }

  close(name: string): this {
    return this.raw(`</${name}>\n`);
  }

  /** `<name ...>text</name>` on one line (readers take the text as is). */
  element(name: string, attrs: Record<string, string | number | undefined>, text: string): this {
    let s = `<${name}`;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      s += ` ${k}="${typeof v === "number" ? v : escapeXml(v)}"`;
    }
    return this.raw(`${s}>${escapeXml(text)}</${name}>\n`);
  }

  /** The document as UTF-8 bytes. */
  toBytes(): Uint8Array {
    const enc = new TextEncoder();
    const parts = [...this.chunks, this.buf].map((c) => enc.encode(c));
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  toString(): string {
    return this.chunks.join("") + this.buf;
  }
}

/** Shortest decimal that reads back as the same float32 (like "%.9g", trimmed). */
export function formatFloat(f: number): string {
  if (Number.isInteger(f)) return String(f);
  for (let digits = 6; digits <= 9; digits++) {
    const s = f.toPrecision(digits);
    if (Math.fround(Number(s)) === Math.fround(f)) return String(Number(s));
  }
  return String(f);
}

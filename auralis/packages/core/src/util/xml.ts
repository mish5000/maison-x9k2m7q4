/**
 * A small, bounded XML reader used by the RSS/Atom and WebDAV adapters.
 *
 * Written in-house rather than pulled from a dependency because the security
 * requirements are unusual: it must never resolve external entities, never
 * follow a DOCTYPE, and must refuse to expand beyond hard limits. Those three
 * properties are what make XXE and billion-laughs attacks impossible here.
 */

export interface XmlNode {
  readonly name: string;
  /** Local name with any namespace prefix removed. */
  readonly localName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  readonly text: string;
}

export interface XmlParseOptions {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxTextLength?: number;
}

const DEFAULT_MAX_NODES = 20_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_TEXT = 64 * 1024;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    // Anything outside the five predefined entities is dropped, not resolved.
    return ENTITIES[entity.toLowerCase()] ?? '';
  });
}

interface MutableNode {
  name: string;
  localName: string;
  attributes: Record<string, string>;
  children: MutableNode[];
  text: string;
}

export class XmlLimitExceededError extends Error {
  constructor(limit: string) {
    super(`XML document exceeded the ${limit} limit`);
    this.name = 'XmlLimitExceededError';
  }
}

export function parseXml(source: string, options: XmlParseOptions = {}): XmlNode | null {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxText = options.maxTextLength ?? DEFAULT_MAX_TEXT;

  // Remove comments, processing instructions, and DOCTYPE declarations. The
  // DOCTYPE is discarded rather than parsed, which is what closes off XXE.
  const text = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '');

  const root: MutableNode = {
    name: '#root',
    localName: '#root',
    attributes: {},
    children: [],
    text: '',
  };
  const stack: MutableNode[] = [root];
  let nodeCount = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    if (open === -1) {
      appendText(stack, text.slice(cursor), maxText);
      break;
    }
    if (open > cursor) appendText(stack, text.slice(cursor, open), maxText);

    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      const content = end === -1 ? text.slice(open + 9) : text.slice(open + 9, end);
      appendRawText(stack, content, maxText);
      cursor = end === -1 ? text.length : end + 3;
      continue;
    }

    const close = text.indexOf('>', open);
    if (close === -1) break;
    const rawTag = text.slice(open + 1, close).trim();
    cursor = close + 1;
    if (rawTag.length === 0) continue;

    if (rawTag.startsWith('/')) {
      const name = rawTag.slice(1).trim();
      // Pop to the matching element; ignore stray closers.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]?.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch?.[1]) continue;

    nodeCount += 1;
    if (nodeCount > maxNodes) throw new XmlLimitExceededError('node count');
    if (stack.length > maxDepth) throw new XmlLimitExceededError('depth');

    const name = nameMatch[1];
    const node: MutableNode = {
      name,
      localName: name.includes(':') ? (name.split(':').pop() ?? name) : name,
      attributes: parseAttributes(body.slice(name.length)),
      children: [],
      text: '',
    };

    stack[stack.length - 1]?.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root.children.length > 0 ? freeze(root) : null;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = pattern.exec(source)) !== null && count < 64) {
    const key = match[1]?.toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    if (key) attributes[key] = decodeXmlEntities(value);
    count += 1;
  }
  return attributes;
}

function appendText(stack: readonly MutableNode[], raw: string, maxText: number): void {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  appendRawText(stack, decodeXmlEntities(trimmed), maxText);
}

function appendRawText(stack: readonly MutableNode[], value: string, maxText: number): void {
  const node = stack[stack.length - 1];
  if (!node) return;
  if (node.text.length >= maxText) return;
  node.text = (node.text + value).slice(0, maxText);
}

function freeze(node: MutableNode): XmlNode {
  return {
    name: node.name,
    localName: node.localName,
    attributes: Object.freeze({ ...node.attributes }),
    children: node.children.map(freeze),
    text: node.text,
  };
}

/** Depth-first search for the first descendant with the given local name. */
export function findChild(node: XmlNode | null, localName: string): XmlNode | null {
  if (!node) return null;
  for (const child of node.children) {
    if (child.localName.toLowerCase() === localName.toLowerCase()) return child;
  }
  return null;
}

export function findChildren(node: XmlNode | null, localName: string): readonly XmlNode[] {
  if (!node) return [];
  return node.children.filter((child) => child.localName.toLowerCase() === localName.toLowerCase());
}

export function findDescendants(
  node: XmlNode | null,
  localName: string,
  limit = 500,
): readonly XmlNode[] {
  if (!node) return [];
  const target = localName.toLowerCase();
  const out: XmlNode[] = [];
  const queue: XmlNode[] = [...node.children];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift();
    if (!current) break;
    if (current.localName.toLowerCase() === target) out.push(current);
    queue.push(...current.children);
  }
  return out;
}

export function textOf(node: XmlNode | null): string | null {
  const value = node?.text.trim();
  return value && value.length > 0 ? value : null;
}

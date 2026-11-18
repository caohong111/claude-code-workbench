const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function remarkWindowsFileLinks() {
  return (tree, file) => {
    const markdown = String(file.value || '');
    const visit = (node) => {
      if ((node.type === 'link' || node.type === 'image') && node.position) {
        const source = markdown.slice(node.position.start.offset, node.position.end.offset);
        // Recover the destination before Markdown consumes backslashes such as \\.tmp.
        const destination = source.match(/\]\(\s*<([a-z]:[\\/][^<>\r\n]*)>(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\)))?\s*\)$/i)?.[1];
        if (destination?.includes('\\')) node.url = destination.replaceAll('\\', '/').replaceAll('#', '%23').replaceAll('?', '%3F');
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

export function classifyChatHref(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || CONTROL_CHARACTERS.test(value)) return 'blocked';
  if (value.startsWith('#')) return 'anchor';
  if (/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(value)) return 'local';
  if (/^file:/i.test(value)) return 'local';
  if (/^[\\/]{2}/.test(value)) return 'blocked';
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? 'external' : 'blocked';
    } catch { return 'blocked'; }
  }
  return 'local';
}

export function chatUrlTransform(value) {
  return classifyChatHref(value) === 'blocked' ? '' : value;
}

export interface AriaElement {
  role: string;
  name: string;
}

export function parseAriaSnapshot(snapshot: string): AriaElement[] {
  const lines = snapshot.split(/\r?\n/);
  const results: AriaElement[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*-\s*([A-Za-z]+)\b/);
    if (!match) continue;

    const role = match[1];
    const afterRoleIndex = (match.index ?? 0) + match[0].length;
    const quoteStart = line.indexOf('"', afterRoleIndex);
    if (quoteStart === -1) {
      const remainder = line.slice(afterRoleIndex);
      if (role === 'text' && remainder.startsWith(':')) {
        results.push({ role, name: remainder.slice(1).trim() });
      } else if (remainder.trim() === '') {
        results.push({ role, name: '' });
      }
      continue;
    }

    let name = '';
    let i = quoteStart + 1;
    let closed = false;

    while (i < line.length) {
      if (line[i] === '\\') {
        if (i + 1 < line.length) {
          const next = line[i + 1];
          if (next === '"') {
            name += '"';
            i += 2;
          } else if (next === '\\') {
            name += '\\';
            i += 2;
          } else {
            name += next;
            i += 2;
          }
        } else {
          name += '\\';
          i++;
        }
      } else if (line[i] === '"') {
        closed = true;
        break;
      } else {
        name += line[i];
        i++;
      }
    }

    if (closed) {
      results.push({ role, name });
    }
  }

  return results;
}

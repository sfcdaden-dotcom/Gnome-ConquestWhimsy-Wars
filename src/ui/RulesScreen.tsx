/**
 * The rules, readable in-app. RULES.md is inlined into the bundle at build
 * time (vite `?raw`), so this costs no network request and cannot drift from
 * the repo's canonical spec — it IS the spec, rendered.
 *
 * The renderer below handles exactly the constructs RULES.md uses — headings,
 * bullet and numbered lists, tables, bold/italic/code — rather than pulling in
 * a markdown dependency for one static document. If RULES.md grows syntax this
 * does not know, the fallback is visible (the raw line shows), not silent.
 */

import { Fragment } from 'react';
import type { JSX, ReactNode } from 'react';
import rulesText from '../../RULES.md?raw';

// ---------------------------------------------------------------------------
// Inline markdown: **bold**, *italic*, `code` — the only spans RULES.md uses.
// ---------------------------------------------------------------------------

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

function renderInline(text: string): ReactNode {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'para'; text: string };

/**
 * Continuation lines (two-space indents under a bullet, wrapped paragraph
 * lines) are folded into the entry they continue — markdown's soft wrapping.
 */
function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '' || line.startsWith('---')) {
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        // The |---|---| separator row is layout, not content.
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }

    const listStart = /^(-|\d+\.)\s+/.exec(line);
    if (listStart) {
      const ordered = listStart[1] !== '-';
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(-|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push(m[2]);
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Paragraph: consecutive plain lines fold into one.
    let text = line.trim();
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|\||-|\d+\.)/.test(lines[i].trim())) {
      text += ' ' + lines[i].trim();
      i++;
    }
    blocks.push({ kind: 'para', text });
  }

  return blocks;
}

const BLOCKS = parseBlocks(rulesText);

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${Math.min(block.level + 1, 6)}` as keyof JSX.IntrinsicElements;
      return <Tag key={key}>{renderInline(block.text)}</Tag>;
    }
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <table key={key}>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) =>
                  r === 0 ? <th key={c}>{renderInline(cell)}</th> : <td key={c}>{renderInline(cell)}</td>,
                )}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'para':
      return <p key={key}>{renderInline(block.text)}</p>;
  }
}

// ---------------------------------------------------------------------------

export function RulesScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="rules-screen" data-testid="rules-screen">
      <header className="rules-header">
        <button type="button" className="btn" data-testid="rules-back" onClick={onBack}>
          ← Back
        </button>
        <span className="brand">🧙 Whimsy Wars — how to play</span>
      </header>
      <article className="rules-body">{BLOCKS.map(renderBlock)}</article>
    </div>
  );
}

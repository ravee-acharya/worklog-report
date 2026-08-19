import { extractWorklogComment } from '../index';

/** Shorthand for the paragraph-inside-listItem shape Jira always emits. */
function li(text: string, ...extra: unknown[]) {
  return {
    type: 'listItem',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...extra,
    ],
  };
}

function bullets(...items: unknown[]) {
  return { type: 'doc', version: 1, content: [{ type: 'bulletList', content: items }] };
}

describe('extractWorklogComment — bullet lists', () => {
  // Captured verbatim from a real worklog by Pratik Sonigra on RAT-141, which
  // is what surfaced this bug. Before the fix these six bullets came back as
  // one run-together string with no separators at all.
  const RAT_141 = bullets(
    li('Clone the MedFlowAI repo.'),
    li('Understand the architecture.'),
    li('Implemented UI for:', {
      type: 'bulletList',
      content: [li('Auth'), li('Agents')],
    }),
    li('Meetings and discussions.'),
  );

  it('renders the real RAT-141 comment as bullets, including the nested pair', () => {
    expect(extractWorklogComment(RAT_141)).toBe(
      [
        '• Clone the MedFlowAI repo.',
        '• Understand the architecture.',
        '• Implemented UI for:',
        '  ◦ Auth',
        '  ◦ Agents',
        '• Meetings and discussions.',
      ].join('\n'),
    );
  });

  // The specific regression: list items used to be concatenated with '', so
  // adjacent bullets fused into one word ("repo.Understand").
  it('never fuses adjacent list items together', () => {
    const out = extractWorklogComment(RAT_141);
    expect(out).not.toContain('repo.Understand');
    expect(out).not.toContain('for:Auth');
    expect(out).not.toContain('AuthAgents');
  });

  it('puts every top-level bullet on its own line', () => {
    const out = extractWorklogComment(bullets(li('One'), li('Two'), li('Three')));
    expect(out.split('\n')).toEqual(['• One', '• Two', '• Three']);
  });

  it('indents each nesting level and changes the glyph', () => {
    const doc = bullets(
      li('L1', {
        type: 'bulletList',
        content: [
          li('L2', { type: 'bulletList', content: [li('L3')] }),
        ],
      }),
    );
    expect(extractWorklogComment(doc).split('\n')).toEqual([
      '• L1',
      '  ◦ L2',
      '    ▪ L3',
    ]);
  });

  it('numbers ordered lists and honours a non-1 start', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'orderedList', content: [li('First'), li('Second')] },
        { type: 'orderedList', attrs: { order: 5 }, content: [li('Fifth')] },
      ],
    };
    expect(extractWorklogComment(doc).split('\n')).toEqual([
      '1. First',
      '2. Second',
      '5. Fifth',
    ]);
  });

  it('aligns a wrapped continuation under its own marker', () => {
    const doc = bullets(
      li('Main point', { type: 'paragraph', content: [{ type: 'text', text: 'More detail' }] }),
    );
    expect(extractWorklogComment(doc).split('\n')).toEqual([
      '• Main point',
      '  More detail',
    ]);
  });
});

describe('extractWorklogComment — other content', () => {
  it('keeps paragraphs on separate lines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Line two' }] },
      ],
    };
    expect(extractWorklogComment(doc)).toBe('Line one\nLine two');
  });

  it('treats a hardBreak as a line break', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Before' },
            { type: 'hardBreak' },
            { type: 'text', text: 'After' },
          ],
        },
      ],
    };
    expect(extractWorklogComment(doc)).toBe('Before\nAfter');
  });

  it('collapses runs of empty paragraphs to a single blank line', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
      ],
    };
    expect(extractWorklogComment(doc)).toBe('A\n\nB');
  });

  it('keeps mention and emoji text rather than dropping the nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Paired with ' },
            { type: 'mention', attrs: { id: 'abc', text: '@Ravi Acharya' } },
            { type: 'text', text: ' ' },
            { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
          ],
        },
      ],
    };
    expect(extractWorklogComment(doc)).toBe('Paired with @Ravi Acharya 🎉');
  });

  it('passes a plain-string comment straight through', () => {
    expect(extractWorklogComment('Just a string')).toBe('Just a string');
  });

  it('returns empty string for null/undefined/empty documents', () => {
    expect(extractWorklogComment(null)).toBe('');
    expect(extractWorklogComment(undefined)).toBe('');
    expect(extractWorklogComment({ type: 'doc', content: [] })).toBe('');
  });

  // The report flags cells whose worklogs have blank comments; that check is
  // `extractWorklogComment(...).trim()`, so a whitespace-only ADF document
  // must not read as non-empty.
  it('treats a document of empty paragraphs as blank', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
    expect(extractWorklogComment(doc).trim()).toBe('');
  });
});

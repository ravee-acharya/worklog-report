import { bridge } from '@forge/bridge';
import { buildCommentsCsv, fetchAllWorklogEntries, encodeCsvForDownload } from '../index';
import type {
  WorklogEntriesResponse,
  WorklogExportEntry,
  WorklogReportRequest,
} from '../../types/worklog-types';

beforeEach(() => bridge.reset());

function entry(overrides: Partial<WorklogExportEntry> = {}): WorklogExportEntry {
  return {
    issueKey: 'PROJ-1',
    issueSummary: 'Build the thing',
    projectKey: 'PROJ',
    issueType: 'Task',
    authorDisplayName: 'Alice Smith',
    loggedDate: '2026-01-05',
    createdDate: '2026-01-05T09:00:00.000+0000',
    timeSpentHours: 2,
    comment: 'Did the work',
    ...overrides,
  };
}

/** Split one CSV line into fields, honouring RFC4180 quoting. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// ---------------------------------------------------------------------------
// buildCommentsCsv
// ---------------------------------------------------------------------------
describe('buildCommentsCsv', () => {
  it('emits a header, one row per worklog, and a total row', () => {
    const csv = buildCommentsCsv([entry(), entry({ issueKey: 'PROJ-2', timeSpentHours: 1.5 })]);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(4); // header + 2 rows + total
    expect(parseCsvLine(lines[0])).toEqual([
      'Author',
      'Date Logged',
      'Project',
      'Issue Key',
      'Issue Summary',
      'Issue Type',
      'Hours',
      'Comment',
      'Worklog Created Date',
    ]);

    const totalFields = parseCsvLine(lines[3]);
    expect(totalFields[0]).toBe('Total');
    expect(totalFields[6]).toBe('3.5');
  });

  // Worklog comments are free text, and real ones routinely contain commas
  // ("Managing the board, helping the team"). Unescaped, a single comma shifts
  // every following column by one and silently corrupts the file.
  it('quotes a comment containing commas so the columns do not shift', () => {
    const csv = buildCommentsCsv([
      entry({ comment: 'Managing the board, helping the team, and cleanup' }),
    ]);
    const fields = parseCsvLine(csv.split('\n')[1]);

    expect(fields).toHaveLength(9);
    expect(fields[7]).toBe('Managing the board, helping the team, and cleanup');
    expect(fields[8]).toBe('2026-01-05T09:00:00.000+0000');
  });

  it('escapes embedded double quotes', () => {
    const csv = buildCommentsCsv([entry({ comment: 'He said "ship it" today' })]);
    expect(parseCsvLine(csv.split('\n')[1])[7]).toBe('He said "ship it" today');
  });

  it('keeps a multi-line comment inside one quoted field', () => {
    const csv = buildCommentsCsv([entry({ comment: 'Line one\nLine two' })]);

    expect(csv).toContain('"Line one\nLine two"');
    // The trailing Total row still terminates the file correctly.
    expect(parseCsvLine(csv.split('\n').pop() as string)[0]).toBe('Total');
  });

  // Composition guard: the resolver renders ADF bullet lists to text carrying
  // '•' markers and newline-separated lines (see extractWorklogComment). Those
  // newlines must survive into the CSV as one quoted field, or the bullets the
  // author wrote arrive in Excel as separate broken rows.
  it('carries a bulleted comment through as a single quoted field', () => {
    const bulleted = [
      '• Clone the MedFlowAI repo.',
      '• Implemented UI for:',
      '  ◦ Auth',
      '  ◦ Agents',
    ].join('\n');

    const csv = buildCommentsCsv([entry({ comment: bulleted })]);

    expect(csv).toContain(`"${bulleted}"`);
    // Header, the (multi-line) row, and the Total row — the embedded newlines
    // live inside quotes, so they must not create extra CSV records.
    expect(csv.split('\n')).toHaveLength(3 + 3);
    expect(parseCsvLine(csv.split('\n').pop() as string)[0]).toBe('Total');
  });

  it('still emits a row for a worklog with no comment', () => {
    const csv = buildCommentsCsv([entry({ comment: '' })]);
    const fields = parseCsvLine(csv.split('\n')[1]);

    expect(fields[7]).toBe('');
    expect(fields[6]).toBe('2');
  });

  it('sorts by author, then date logged, then issue key', () => {
    const csv = buildCommentsCsv([
      entry({ authorDisplayName: 'Bob Jones', loggedDate: '2026-01-01' }),
      entry({ authorDisplayName: 'Alice Smith', loggedDate: '2026-01-07', issueKey: 'PROJ-9' }),
      entry({ authorDisplayName: 'Alice Smith', loggedDate: '2026-01-02' }),
    ]);
    const rows = csv
      .split('\n')
      .slice(1, 4)
      .map(parseCsvLine);

    expect(rows.map((r) => [r[0], r[1]])).toEqual([
      ['Alice Smith', '2026-01-02'],
      ['Alice Smith', '2026-01-07'],
      ['Bob Jones', '2026-01-01'],
    ]);
  });

  it('sums fractional hours without floating-point drift', () => {
    const csv = buildCommentsCsv([
      entry({ timeSpentHours: 0.5 }),
      entry({ timeSpentHours: 3 }),
      entry({ timeSpentHours: 4.25 }),
    ]);
    expect(parseCsvLine(csv.split('\n').pop() as string)[6]).toBe('7.75');
  });
});

// ---------------------------------------------------------------------------
// encodeCsvForDownload
// ---------------------------------------------------------------------------
describe('encodeCsvForDownload', () => {
  // Regression: without a BOM, Excel decodes the file as Windows-1252 and an
  // en dash in a Jira issue summary reaches the user as "â€“".
  it('prefixes a UTF-8 BOM so Excel does not decode the file as Windows-1252', () => {
    const encoded = encodeCsvForDownload('Author,Comment\nAlice,Hi');

    expect(encoded.charCodeAt(0)).toBe(0xfeff);
    expect(encoded.slice(1)).toBe('Author,Comment\nAlice,Hi');
  });

  it('encodes to the EF BB BF byte prefix', () => {
    const bytes = Buffer.from(encodeCsvForDownload('x'), 'utf8');
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  // The exact characters that were showing up mangled in the real export.
  it('round-trips non-ASCII characters found in real Jira data', () => {
    const summary = 'Jira Worklog Reporting App (Forge) – Developer Instructions';
    const comment = 'Worked on data mismatch bug for Hitesh’s case';
    const csv = buildCommentsCsv([entry({ issueSummary: summary, comment })]);

    const decoded = Buffer.from(encodeCsvForDownload(csv), 'utf8').toString('utf8');
    expect(decoded).toContain(summary);
    expect(decoded).toContain(comment);
    // The mojibake forms must not appear anywhere.
    expect(decoded).not.toContain('â€');
  });

  it('adds exactly one BOM, not one per call site', () => {
    const encoded = encodeCsvForDownload('a,b');
    expect(encoded.match(/\uFEFF/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fetchAllWorklogEntries
// ---------------------------------------------------------------------------
describe('fetchAllWorklogEntries', () => {
  function baseReq(overrides: Partial<WorklogReportRequest> = {}): WorklogReportRequest {
    return {
      projectKeys: [],
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      period: 'day',
      timeUnit: 'decimal',
      timeZone: 'UTC',
      grandTotal: false,
      ...overrides,
    };
  }

  function mkEntry(issueKey: string): WorklogExportEntry {
    return entry({ issueKey, comment: `Comment for ${issueKey}` });
  }

  it('follows nextPageToken to the last page and concatenates every entry', async () => {
    let call = 0;
    bridge.mockInvoke('getWorklogEntriesPage', (): WorklogEntriesResponse => {
      call++;
      const last = call === 3;
      return {
        entries: [mkEntry(`PROJ-${call}`)],
        nextPageToken: last ? null : `token-${call}`,
        isComplete: last,
        progress: { loadedIssues: 1, totalIssues: 3 },
      };
    });

    const entries = await fetchAllWorklogEntries(baseReq());

    expect(call).toBe(3);
    expect(entries.map((e) => e.issueKey)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
  });

  it('sends the page token back on the following request', async () => {
    const seenTokens: Array<string | undefined> = [];
    let call = 0;
    bridge.mockInvoke(
      'getWorklogEntriesPage',
      (payload: WorklogReportRequest): WorklogEntriesResponse => {
        seenTokens.push(payload.pageToken);
        call++;
        const last = call === 2;
        return {
          entries: [],
          nextPageToken: last ? null : 'next-token',
          isComplete: last,
          progress: { loadedIssues: 0, totalIssues: 0 },
        };
      },
    );

    await fetchAllWorklogEntries(baseReq());

    expect(seenTokens).toEqual([undefined, 'next-token']);
  });

  it('splits a multi-month range into per-month requests, never outside the range', async () => {
    const seenRanges: Array<{ start: string; end: string }> = [];
    bridge.mockInvoke(
      'getWorklogEntriesPage',
      (payload: WorklogReportRequest): WorklogEntriesResponse => {
        seenRanges.push({ start: payload.startDate, end: payload.endDate });
        return {
          entries: [mkEntry('PROJ-1')],
          nextPageToken: null,
          isComplete: true,
          progress: { loadedIssues: 1, totalIssues: 1 },
        };
      },
    );

    const entries = await fetchAllWorklogEntries(
      baseReq({ startDate: '2026-01-10', endDate: '2026-03-05' }),
    );

    expect(seenRanges).toHaveLength(3); // Jan, Feb, Mar
    for (const range of seenRanges) {
      expect(range.start >= '2026-01-10').toBe(true);
      expect(range.end <= '2026-03-05').toBe(true);
    }
    // Month chunks partition the range, so a worklog belongs to exactly one
    // chunk and the results concatenate without any merging.
    expect(entries).toHaveLength(3);
  });
});

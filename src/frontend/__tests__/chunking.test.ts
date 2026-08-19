import { bridge } from '@forge/bridge';
import {
  splitIntoMonthChunks,
  mapWithConcurrency,
  mergeReportChunks,
  fetchChunkedReport,
} from '../index';
import type { WorklogReportRequest, WorklogReportResponse } from '../../types/worklog-types';

beforeEach(() => bridge.reset());

// ---------------------------------------------------------------------------
// splitIntoMonthChunks
// ---------------------------------------------------------------------------
describe('splitIntoMonthChunks', () => {
  it('returns a single chunk for a range within one calendar month', () => {
    expect(splitIntoMonthChunks('2026-01-05', '2026-01-20')).toEqual([
      { start: '2026-01-05', end: '2026-01-20' },
    ]);
  });

  it('splits a multi-month range on calendar-month boundaries', () => {
    expect(splitIntoMonthChunks('2026-01-15', '2026-03-10')).toEqual([
      { start: '2026-01-15', end: '2026-01-31' },
      { start: '2026-02-01', end: '2026-02-28' },
      { start: '2026-03-01', end: '2026-03-10' },
    ]);
  });

  it('handles a full-year range (Jan 1 - Jul 30) as one chunk per month', () => {
    const chunks = splitIntoMonthChunks('2026-01-01', '2026-07-30');
    expect(chunks).toHaveLength(7);
    expect(chunks[0]).toEqual({ start: '2026-01-01', end: '2026-01-31' });
    expect(chunks[6]).toEqual({ start: '2026-07-01', end: '2026-07-30' });
  });

  it('produces disjoint, non-overlapping chunks (no worklog can be double-counted)', () => {
    const chunks = splitIntoMonthChunks('2026-01-01', '2026-04-15');
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start > chunks[i - 1].end).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// mapWithConcurrency
// ---------------------------------------------------------------------------
describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    const items = [30, 10, 20, 5];
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(results).toEqual([30, 10, 20, 5]);
  });

  it('never runs more than `limit` callbacks concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// mergeReportChunks
// ---------------------------------------------------------------------------
describe('mergeReportChunks', () => {
  it('sums contributions from different chunks to the same boundary dateLabel', () => {
    // A week bucket ("2026-01-26") straddling the Jan/Feb boundary — the Jan
    // chunk only has Jan 26-31's hours for it, the Feb chunk only has Feb
    // 1-1's hours; the true total is the sum of both.
    const janChunk = {
      headers: ['Author'],
      rows: [
        {
          groupColumns: [{ dimension: 'author', label: 'Alice' }],
          dateHours: [{ dateLabel: '2026-01-26', hours: 3 }],
          rowTotalHours: 3,
          issueKeys: ['PROJ-1'],
        },
      ],
    };
    const febChunk = {
      headers: ['Author'],
      rows: [
        {
          groupColumns: [{ dimension: 'author', label: 'Alice' }],
          dateHours: [{ dateLabel: '2026-01-26', hours: 5 }, { dateLabel: '2026-02-02', hours: 2 }],
          rowTotalHours: 7,
          issueKeys: ['PROJ-2'],
        },
      ],
    };

    const merged = mergeReportChunks([janChunk, febChunk]);

    expect(merged.headers).toEqual(['Author']);
    expect(merged.rows).toHaveLength(1);
    const alice = merged.rows[0];
    expect(alice.dateHours).toEqual([
      { dateLabel: '2026-01-26', hours: 8, hasEmptyComment: false },
      { dateLabel: '2026-02-02', hours: 2, hasEmptyComment: false },
    ]);
    expect(alice.rowTotalHours).toBe(10);
    expect(alice.issueKeys).toEqual(expect.arrayContaining(['PROJ-1', 'PROJ-2']));
  });

  it('keeps rows that only appear in one chunk, zero-filled for other chunks’ labels', () => {
    const chunk1 = {
      headers: ['Author'],
      rows: [
        {
          groupColumns: [{ dimension: 'author', label: 'Alice' }],
          dateHours: [{ dateLabel: '2026-01-01', hours: 4 }],
          rowTotalHours: 4,
        },
      ],
    };
    const chunk2 = {
      headers: ['Author'],
      rows: [
        {
          groupColumns: [{ dimension: 'author', label: 'Bob' }],
          dateHours: [{ dateLabel: '2026-02-01', hours: 6 }],
          rowTotalHours: 6,
        },
      ],
    };

    const merged = mergeReportChunks([chunk1, chunk2]);
    const bob = merged.rows.find((r) => r.groupColumns[0].label === 'Bob')!;
    // Bob's row spans the union of dateLabels (both chunks), zero for the
    // label he has no hours in.
    expect(bob.dateHours).toEqual([
      { dateLabel: '2026-01-01', hours: 0, hasEmptyComment: false },
      { dateLabel: '2026-02-01', hours: 6, hasEmptyComment: false },
    ]);
  });

  it('propagates hasEmptyComment across chunks', () => {
    const chunk1 = {
      headers: ['Author'],
      rows: [
        {
          groupColumns: [{ dimension: 'author', label: 'Alice' }],
          dateHours: [{ dateLabel: '2026-01-01', hours: 1, hasEmptyComment: true }],
          rowTotalHours: 1,
          rowHasEmptyComment: true,
        },
      ],
    };
    const merged = mergeReportChunks([chunk1]);
    expect(merged.rows[0].dateHours[0].hasEmptyComment).toBe(true);
    expect(merged.rows[0].rowHasEmptyComment).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchChunkedReport (integration with the getWorklogReport bridge mock)
// ---------------------------------------------------------------------------
describe('fetchChunkedReport', () => {
  function baseRequest(overrides: Partial<WorklogReportRequest> = {}): WorklogReportRequest {
    return {
      projectKeys: [],
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      period: 'month',
      timeUnit: 'decimal',
      timeZone: 'UTC',
      grandTotal: false,
      ...overrides,
    };
  }

  it('makes a single getWorklogReport call for a single-month range', async () => {
    bridge.mockInvoke('getWorklogReport', (): WorklogReportResponse => ({
      groupColumnHeaders: ['Author'],
      rows: [],
      grandTotal: null,
      nextPageToken: null,
      isComplete: true,
      progress: { loadedIssues: 0, totalIssues: 0 },
    }));

    await fetchChunkedReport(baseRequest());

    const calls = bridge.invocations.filter((i) => i.functionKey === 'getWorklogReport');
    expect(calls).toHaveLength(1);
  });

  it('fans out one getWorklogReport call per calendar month for a wide range, and merges the totals', async () => {
    bridge.mockInvoke('getWorklogReport', (payload: WorklogReportRequest): WorklogReportResponse => {
      // Each month contributes a distinct, deterministic amount of hours for
      // the same author so the merged total can be checked precisely.
      const hoursByMonth: Record<string, number> = {
        '2026-01-01': 10,
        '2026-02-01': 20,
        '2026-03-01': 5,
      };
      const hours = hoursByMonth[payload.startDate] ?? 0;
      return {
        groupColumnHeaders: ['Author'],
        rows: [
          {
            groupColumns: [{ dimension: 'author', label: 'Alice' }],
            dateHours: [{ dateLabel: payload.startDate, hours }],
            rowTotalHours: hours,
            issueKeys: [`ISSUE-${payload.startDate}`],
          },
        ],
        grandTotal: null,
        nextPageToken: null,
        isComplete: true,
        progress: { loadedIssues: 1, totalIssues: 1 },
      };
    });

    const result = await fetchChunkedReport(
      baseRequest({ startDate: '2026-01-01', endDate: '2026-03-31' }),
    );

    const calls = bridge.invocations.filter((i) => i.functionKey === 'getWorklogReport');
    // One call per calendar month in the range (Jan, Feb, Mar).
    expect(calls).toHaveLength(3);

    expect(result.rows).toHaveLength(1);
    const alice = result.rows[0];
    expect(alice.rowTotalHours).toBe(35); // 10 + 20 + 5
    expect(alice.issueKeys).toEqual(
      expect.arrayContaining(['ISSUE-2026-01-01', 'ISSUE-2026-02-01', 'ISSUE-2026-03-01']),
    );
  });

  it('never fetches worklogs outside the requested range when chunking', async () => {
    const seenRanges: Array<{ start: string; end: string }> = [];
    bridge.mockInvoke('getWorklogReport', (payload: WorklogReportRequest): WorklogReportResponse => {
      seenRanges.push({ start: payload.startDate, end: payload.endDate });
      return {
        groupColumnHeaders: [],
        rows: [],
        grandTotal: null,
        nextPageToken: null,
        isComplete: true,
        progress: { loadedIssues: 0, totalIssues: 0 },
      };
    });

    await fetchChunkedReport(baseRequest({ startDate: '2026-01-10', endDate: '2026-02-20' }));

    for (const range of seenRanges) {
      expect(range.start >= '2026-01-10').toBe(true);
      expect(range.end <= '2026-02-20').toBe(true);
    }
  });
});

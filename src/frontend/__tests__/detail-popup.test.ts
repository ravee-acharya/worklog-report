import { buildGrandTotalDrillDownRow, formatLoggedDate } from '../index';
import type { WorklogReportResponse } from '../../types/worklog-types';

type Rows = WorklogReportResponse['rows'];
type GrandTotal = NonNullable<WorklogReportResponse['grandTotal']>;

function row(overrides: Partial<Rows[0]> = {}): Rows[0] {
  return {
    groupColumns: [{ dimension: 'author', label: 'Alice Smith' }],
    dateHours: [{ dateLabel: '2026-08-17', hours: 2 }],
    rowTotalHours: 2,
    issueKeys: ['PROJ-1'],
    ...overrides,
  };
}

function grandTotal(overrides: Partial<GrandTotal> = {}): GrandTotal {
  return {
    dateHours: [{ dateLabel: '2026-08-17', hours: 5 }],
    grandTotalHours: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatLoggedDate — backs the popup's "Worklog Date" column
// ---------------------------------------------------------------------------
describe('formatLoggedDate', () => {
  it('renders a YYYY-MM-DD date as DD-MM-YYYY, matching the report column headers', () => {
    expect(formatLoggedDate('2026-08-17')).toBe('17-08-2026');
  });

  it('keeps the leading zeros on single-digit days and months', () => {
    expect(formatLoggedDate('2026-01-05')).toBe('05-01-2026');
  });

  // The value is a bare calendar date with no time or zone. Parsing it through
  // Date would make it midnight UTC and a negative-offset timezone would then
  // render the previous day — the whole reason this formatter is string-only.
  it('does not shift the date regardless of the host timezone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(formatLoggedDate('2026-08-17')).toBe('17-08-2026');
      process.env.TZ = 'Asia/Calcutta';
      expect(formatLoggedDate('2026-08-17')).toBe('17-08-2026');
    } finally {
      process.env.TZ = original;
    }
  });

  it('shows a dash for a missing date rather than an empty cell', () => {
    expect(formatLoggedDate('')).toBe('-');
  });

  it('passes an unexpected format through untouched instead of mangling it', () => {
    expect(formatLoggedDate('not-a-date')).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// buildGrandTotalDrillDownRow — makes the Total row clickable
// ---------------------------------------------------------------------------
describe('buildGrandTotalDrillDownRow', () => {
  it('unions issue keys across every row', () => {
    const built = buildGrandTotalDrillDownRow(
      [
        row({ issueKeys: ['PROJ-1', 'PROJ-2'] }),
        row({ issueKeys: ['PROJ-3'] }),
      ],
      grandTotal(),
    );

    expect([...(built.issueKeys ?? [])].sort()).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
  });

  it('de-duplicates an issue worked on by more than one row', () => {
    const built = buildGrandTotalDrillDownRow(
      [
        row({ groupColumns: [{ dimension: 'author', label: 'Alice Smith' }], issueKeys: ['PROJ-1'] }),
        row({ groupColumns: [{ dimension: 'author', label: 'Bob Jones' }], issueKeys: ['PROJ-1'] }),
      ],
      grandTotal(),
    );

    expect(built.issueKeys).toEqual(['PROJ-1']);
  });

  // The author scope is what stops the cumulative popup over-reporting: a
  // report narrowed to two users must not pull in a third user's worklogs
  // that happen to sit on the same issues.
  it('unions the author group columns so the popup keeps the report’s user scope', () => {
    const built = buildGrandTotalDrillDownRow(
      [
        row({ groupColumns: [{ dimension: 'author', label: 'Alice Smith' }] }),
        row({ groupColumns: [{ dimension: 'author', label: 'Bob Jones' }] }),
        row({ groupColumns: [{ dimension: 'author', label: 'Alice Smith' }] }),
      ],
      grandTotal(),
    );

    expect(built.groupColumns).toEqual([
      { dimension: 'author', label: 'Alice Smith' },
      { dimension: 'author', label: 'Bob Jones' },
    ]);
  });

  // When the report isn't grouped by author there is no author filter to
  // preserve — matching what an individual row's drill-down already does.
  it('produces no author columns when the report is not grouped by author', () => {
    const built = buildGrandTotalDrillDownRow(
      [
        row({ groupColumns: [{ dimension: 'project', label: 'Project Alpha' }] }),
        row({ groupColumns: [{ dimension: 'issuetype', label: 'Task' }] }),
      ],
      grandTotal(),
    );

    expect(built.groupColumns).toEqual([]);
  });

  it('ignores non-author dimensions while keeping the authors beside them', () => {
    const built = buildGrandTotalDrillDownRow(
      [
        row({
          groupColumns: [
            { dimension: 'project', label: 'Project Alpha' },
            { dimension: 'author', label: 'Alice Smith' },
          ],
        }),
      ],
      grandTotal(),
    );

    expect(built.groupColumns).toEqual([{ dimension: 'author', label: 'Alice Smith' }]);
  });

  it('carries the grand total hours and every date bucket through', () => {
    const built = buildGrandTotalDrillDownRow(
      [row()],
      grandTotal({
        dateHours: [
          { dateLabel: '2026-08-17', hours: 5 },
          { dateLabel: '2026-08-18', hours: 3 },
        ],
        grandTotalHours: 8,
      }),
    );

    expect(built.rowTotalHours).toBe(8);
    expect(built.dateHours).toEqual([
      { dateLabel: '2026-08-17', hours: 5 },
      { dateLabel: '2026-08-18', hours: 3 },
    ]);
  });

  // handleCellClick reads row.issueKeys directly; rows that predate the field
  // (or carry none) must not blow it up.
  it('handles rows with no issueKeys', () => {
    const built = buildGrandTotalDrillDownRow(
      [row({ issueKeys: undefined }), row({ issueKeys: ['PROJ-9'] })],
      grandTotal(),
    );

    expect(built.issueKeys).toEqual(['PROJ-9']);
  });

  it('returns an empty drill-down for an empty report rather than throwing', () => {
    const built = buildGrandTotalDrillDownRow([], grandTotal({ dateHours: [], grandTotalHours: 0 }));

    expect(built.issueKeys).toEqual([]);
    expect(built.groupColumns).toEqual([]);
    expect(built.rowTotalHours).toBe(0);
  });

  // The date cells pass their own dateLabel to handleCellClick, which filters
  // the cached fetch by bucketKey. Those labels have to match the report's.
  it('keeps date labels identical to the grand total’s, so per-column filtering matches', () => {
    const gt = grandTotal({
      dateHours: [
        { dateLabel: '2026-08-17', hours: 5 },
        { dateLabel: '2026-08-18', hours: 0 },
      ],
      grandTotalHours: 5,
    });
    const built = buildGrandTotalDrillDownRow([row()], gt);

    expect(built.dateHours.map((d) => d.dateLabel)).toEqual(gt.dateHours.map((d) => d.dateLabel));
  });
});

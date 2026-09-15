import {
  buildGrandTotalDrillDownRow,
  formatLoggedDate,
  resolveDrillDownAuthorIds,
} from '../index';
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
// resolveDrillDownAuthorIds — which authors the detail popup may show
// ---------------------------------------------------------------------------
describe('resolveDrillDownAuthorIds', () => {
  const USERS = [
    { accountId: 'brij-1', displayName: 'Brij Shingala' },
    { accountId: 'riddhi-2', displayName: 'Riddhi Makwana' },
  ];

  // The reported bug: report filtered to Brij only, but grouped by something
  // other than user, so the row carried no author column. The popup then
  // applied no author filter at all and listed Riddhi's worklogs on the same
  // issues, so its rows didn't add up to the 4.22 that was clicked.
  it('falls back to the report Users filter when the row is not grouped by author', () => {
    const ids = resolveDrillDownAuthorIds(
      [{ dimension: 'project', label: 'Heritagemedcall' }],
      USERS,
      ['brij-1'],
    );

    expect(ids).toEqual(['brij-1']);
    expect(ids).not.toContain('riddhi-2');
  });

  it('uses the row author when the report is grouped by user', () => {
    const ids = resolveDrillDownAuthorIds(
      [{ dimension: 'author', label: 'Brij Shingala' }],
      USERS,
      ['brij-1', 'riddhi-2'],
    );

    // The row is the narrower scope — a Brij row must not show Riddhi even
    // though both users are in the report.
    expect(ids).toEqual(['brij-1']);
  });

  it('resolves every author on a multi-author row', () => {
    const ids = resolveDrillDownAuthorIds(
      [
        { dimension: 'author', label: 'Brij Shingala' },
        { dimension: 'author', label: 'Riddhi Makwana' },
      ],
      USERS,
      [],
    );

    expect(ids).toEqual(['brij-1', 'riddhi-2']);
  });

  // groupColumns only carry a display label, so the accountId is recovered by
  // name. A project-scoped or stale user list makes that lookup miss — which
  // used to drop the filter entirely and widen the popup to every author.
  it('falls back to the report filter when the display-name lookup misses', () => {
    const ids = resolveDrillDownAuthorIds(
      [{ dimension: 'author', label: 'Brij Shingala' }],
      [{ accountId: 'someone-else', displayName: 'Someone Else' }],
      ['brij-1'],
    );

    expect(ids).toEqual(['brij-1']);
  });

  it('falls back when the user list is missing entirely', () => {
    const ids = resolveDrillDownAuthorIds(
      [{ dimension: 'author', label: 'Brij Shingala' }],
      undefined,
      ['brij-1'],
    );

    expect(ids).toEqual(['brij-1']);
  });

  // No Users filter and no author grouping means the report genuinely covers
  // everyone, so the popup must not invent a restriction.
  it('returns no filter when the report covers all users', () => {
    expect(resolveDrillDownAuthorIds([{ dimension: 'project', label: 'HM' }], USERS, [])).toEqual([]);
  });

  // A JQL query overrides the Users filter, so buildRequest sends no authors
  // and the snapshot is empty — the popup must stay unfiltered to match.
  it('stays unfiltered when JQL overrode the Users filter', () => {
    expect(resolveDrillDownAuthorIds([], USERS, [])).toEqual([]);
  });

  it('ignores non-author dimensions when picking the row author', () => {
    const ids = resolveDrillDownAuthorIds(
      [
        { dimension: 'project', label: 'Heritagemedcall' },
        { dimension: 'author', label: 'Riddhi Makwana' },
      ],
      USERS,
      ['brij-1', 'riddhi-2'],
    );

    expect(ids).toEqual(['riddhi-2']);
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

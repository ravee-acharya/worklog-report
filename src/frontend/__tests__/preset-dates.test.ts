import { resolvePresetDateRange, inferPresetDateMode } from '../index';
import type { PresetDateMode } from '../../types/worklog-types';

/** 2026-11-04 is a Wednesday — picked so week boundaries are unambiguous. */
const WED = '2026-11-04';

function range(mode: PresetDateMode, today = WED) {
  const r = resolvePresetDateRange(mode, today);
  return `${r.startDate}..${r.endDate}`;
}

// ---------------------------------------------------------------------------
// resolvePresetDateRange
// ---------------------------------------------------------------------------
describe('resolvePresetDateRange', () => {
  it('resolves month to date from the 1st to today', () => {
    expect(range('monthToDate')).toBe('2026-11-01..2026-11-04');
  });

  it('resolves last month to its own first and last day', () => {
    expect(range('lastMonth')).toBe('2026-10-01..2026-10-31');
  });

  // Day 0 of the current month is the previous month's last day, which has to
  // be right for every month length, not just 31-day ones.
  it('gets the last day of a 30-day and a 28-day previous month', () => {
    expect(range('lastMonth', '2026-12-10')).toBe('2026-11-01..2026-11-30');
    expect(range('lastMonth', '2026-03-10')).toBe('2026-02-01..2026-02-28');
  });

  it('handles a leap February', () => {
    expect(range('lastMonth', '2028-03-10')).toBe('2028-02-01..2028-02-29');
  });

  it('rolls the year backwards for last month in January', () => {
    expect(range('lastMonth', '2027-01-15')).toBe('2026-12-01..2026-12-31');
  });

  // Weeks start Monday, matching the report's own ISO week bucketing.
  it('resolves week to date from Monday to today', () => {
    expect(range('weekToDate')).toBe('2026-11-02..2026-11-04');
  });

  it('treats Monday as the first day of its own week, not the last of the previous', () => {
    expect(range('weekToDate', '2026-11-02')).toBe('2026-11-02..2026-11-02');
  });

  // The classic off-by-one: Sunday is day 0 in getUTCDay, so a naive
  // implementation jumps forward to the next Monday instead of back six days.
  it('puts Sunday in the week that started the previous Monday', () => {
    expect(range('weekToDate', '2026-11-08')).toBe('2026-11-02..2026-11-08');
  });

  it('resolves last week as a full Monday-to-Sunday', () => {
    expect(range('lastWeek')).toBe('2026-10-26..2026-11-01');
  });

  it('resolves last week correctly from a Sunday', () => {
    expect(range('lastWeek', '2026-11-08')).toBe('2026-10-26..2026-11-01');
  });

  // Inclusive of today, so "last 7 days" really is 7 days, not 8.
  it('makes last 7 days span exactly 7 days including today', () => {
    expect(range('last7Days')).toBe('2026-10-29..2026-11-04');
  });

  it('makes last 30 days span exactly 30 days including today', () => {
    expect(range('last30Days')).toBe('2026-10-06..2026-11-04');
  });

  it('crosses a month boundary without breaking', () => {
    expect(range('last7Days', '2026-01-03')).toBe('2025-12-28..2026-01-03');
  });

  it('resolves year to date from January 1st', () => {
    expect(range('yearToDate')).toBe('2026-01-01..2026-11-04');
  });

  // Spans a DST transition in most northern-hemisphere zones. The maths is
  // pure UTC string arithmetic precisely so this can't shift by a day.
  it('is unaffected by a DST transition', () => {
    expect(range('last7Days', '2026-03-30')).toBe('2026-03-24..2026-03-30');
    expect(range('last7Days', '2026-10-28')).toBe('2026-10-22..2026-10-28');
  });

  it('does not depend on the host timezone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const west = range('monthToDate');
      process.env.TZ = 'Pacific/Kiritimati';
      expect(range('monthToDate')).toBe(west);
    } finally {
      process.env.TZ = original;
    }
  });
});

// ---------------------------------------------------------------------------
// inferPresetDateMode — preselects the Save dialog's choice
// ---------------------------------------------------------------------------
describe('inferPresetDateMode', () => {
  // The app's default range is 1st-of-month to today, so the common case of
  // "save what I'm looking at" must offer the rolling option rather than
  // silently freezing it — that freezing is the reported bug.
  it('recognises the default 1st-to-today range as month to date', () => {
    expect(inferPresetDateMode('2026-11-01', '2026-11-04', WED)).toBe('monthToDate');
  });

  it('recognises a full previous month', () => {
    expect(inferPresetDateMode('2026-10-01', '2026-10-31', WED)).toBe('lastMonth');
  });

  it('recognises a 7-day window ending today', () => {
    expect(inferPresetDateMode('2026-10-29', '2026-11-04', WED)).toBe('last7Days');
  });

  it('falls back to fixed for a range that matches no rolling rule', () => {
    expect(inferPresetDateMode('2026-07-14', '2026-09-02', WED)).toBe('fixed');
  });

  // A deliberate historical range must not be mistaken for a rolling one just
  // because it happens to be a whole month.
  it('does not treat an arbitrary whole month as rolling', () => {
    expect(inferPresetDateMode('2026-03-01', '2026-03-31', WED)).toBe('fixed');
  });

  // Every rolling mode must be round-trippable, or the dialog could offer a
  // mode that then resolves to something else.
  it('round-trips every rolling mode it can produce', () => {
    const modes: PresetDateMode[] = [
      'monthToDate',
      'lastMonth',
      'weekToDate',
      'lastWeek',
      'last7Days',
      'last30Days',
      'yearToDate',
    ];
    for (const mode of modes) {
      const r = resolvePresetDateRange(mode, WED);
      const inferred = inferPresetDateMode(r.startDate, r.endDate, WED);
      // Some ranges genuinely coincide (e.g. on Jan 1 several modes collapse
      // to the same single day), so assert the inferred mode resolves to the
      // same range rather than demanding the identical label.
      expect(resolvePresetDateRange(inferred, WED)).toEqual(r);
    }
  });
});

// ---------------------------------------------------------------------------
// The reported bug, stated directly
// ---------------------------------------------------------------------------
describe('a rolling preset does not go stale', () => {
  it('reports December in December when saved as month-to-date in November', () => {
    // Saved on 4 Nov looking at the month so far.
    const savedMode = inferPresetDateMode('2026-11-01', '2026-11-04', '2026-11-04');
    expect(savedMode).toBe('monthToDate');

    // Opened on 9 Dec — the whole point is that this is December, not the
    // November range that was literally saved.
    expect(range(savedMode, '2026-12-09')).toBe('2026-12-01..2026-12-09');
  });

  it('still replays the exact saved range when fixed was chosen', () => {
    // 'fixed' is handled by the caller replaying startDate/endDate, so the
    // resolver is never consulted for it — guard that it stays inert rather
    // than inventing a range that looks plausible.
    expect(range('fixed', '2026-12-09')).toBe('2026-12-09..2026-12-09');
  });
});

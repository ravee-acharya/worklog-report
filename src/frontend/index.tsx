import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import ForgeReconciler, {
  Text,
  Button,
  ButtonGroup,
  Box,
  Inline,
  Stack,
  Spinner,
  SectionMessage,
  Select,
  DatePicker,
  Checkbox,
  Label,
  Textfield,
  DynamicTable,
  Pressable,
  Link,
  Modal,
  ModalTransition,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  xcss,
} from '@forge/react';
import type { XCSSObject } from '@forge/react';
import { invoke } from '@forge/bridge';
import { setupGlobalErrorHandlers, logError, ErrorBoundary } from './utils/errorLogger';
import type {
  WorklogReportRequest,
  WorklogReportResponse,
  WorklogPivotRow,
  FilterOptions,
  FilterPreset,
  FilterPresetsResponse,
  SaveFilterResponse,
  UserPreferences,
  WorklogExportEntry,
  WorklogEntriesResponse,
  CsvExportResponse,
  WorklogDetailEntry,
  WorklogDetailsResponse,
} from '../types/worklog-types';

// ---------------------------------------------------------------------------
// Preview mode detection
// ---------------------------------------------------------------------------
const isAppBuilderPreview =
  typeof window !== 'undefined' &&
  (window as { __FORGE_PREVIEW__?: boolean }).__FORGE_PREVIEW__ === true;

// ---------------------------------------------------------------------------
// Select option type
// ---------------------------------------------------------------------------
interface SelectOption {
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const containerStyle = xcss({
  padding: 'space.300',
});

const toolbarStyle = xcss({
  padding: 'space.200',
  backgroundColor: 'color.background.neutral.subtle',
  borderRadius: 'radius.medium',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderColor: 'color.border',
});

const fieldStyle = xcss({
  minWidth: '130px',
  width: '130px',
});

// Narrower variant for fields whose every option is short — Period's longest
// label is "Month" (5 chars) and Time Unit's is now "Hrs:Min" (see
// TIME_UNIT_OPTIONS) after shortening it from "Hours:Minutes" specifically so
// it could move to this tier. Trims two fields' worth of dead space from the
// toolbar's horizontal scroll on every load without touching anything that
// actually needs the room (Projects/Users hold multi-select chips, From/To
// hold a formatted date, Categorize/Group by can show "Issue Type").
const compactFieldStyle = xcss({
  minWidth: '92px',
  width: '92px',
});

// Narrower than fieldStyle but wider than compactFieldStyle — sized for
// DIMENSION_OPTIONS' longest label ("Issue Type", 10 chars) plus the
// dropdown's own chevron/padding.
const mediumFieldStyle = xcss({
  minWidth: '112px',
  width: '112px',
});

// Narrower than the original 280px. A JQL query is still free text that can
// run far longer than this box — Textfield scrolls its own content
// horizontally rather than growing the box to fit, so a long query stays
// fully usable; this width is chosen to comfortably show a short-to-medium
// query (e.g. the placeholder text) without needlessly widening the toolbar's
// horizontal scroll for the common case.
const jqlFieldStyle = xcss({
  minWidth: '190px',
  width: '190px',
});

// Lets the toolbar scroll sideways instead of wrapping onto a second row, so
// the report table below always gets the rest of the vertical space.
const toolbarScrollStyle = xcss({
  overflowX: 'auto',
  paddingBottom: 'space.050',
});

const tableContainerStyle = xcss({
  marginTop: 'space.300',
});

// ---------------------------------------------------------------------------
// Frozen-header table layout
//
// Forge UI Kit 2's Box only supports `position: 'relative' | 'static'`
// (confirmed via @atlaskit/forge-react-types' BoxProps codegen — no
// 'sticky'), and DynamicTable exposes no scroll events, so a real CSS
// `position: sticky` header (or a JS scroll-sync between two independently
// scrolling tables) isn't available here. A frozen header IS achievable with
// plain nested `overflow` boxes, though, using the classic technique below —
// no JS, no sticky positioning required:
//
//   <Box overflowX="auto">            <- tableHorizontalScrollStyle
//     <Stack>
//       <DynamicTable head={...} rows={[]} />      <- header, no body
//       <Box overflowY="auto" maxHeight={...}>      <- tableBodyVerticalScrollStyle
//         <DynamicTable rows={bodyRows} />          <- body, no head
//       </Box>
//     </Stack>
//   </Box>
//
// Both the header table and the vertical-scroll body box are children of the
// SAME horizontally-scrolling outer Box, so scrolling sideways moves them
// together — the header always stays column-aligned with the body. Scrolling
// down only moves the inner box's content, so the header (a sibling outside
// that inner box) stays visually fixed above it — a true frozen header, with
// no footer freeze (the grand-total row is simply the body's last row, and
// scrolls with the rest of the body).
//
// This does mean the previous two-table split (group/Total columns held
// outside the scroll area, date columns scrolling separately) is retired —
// keeping that split's independent scroll areas in sync with a frozen header
// would need JS-driven scroll-position syncing, which Forge UI Kit 2 doesn't
// expose (Box has no onScroll). The Author/Total columns now scroll
// horizontally along with the date columns instead of staying pinned.
const tableHorizontalScrollStyle = xcss({
  overflowX: 'auto',
});

// A fixed px value, not vh — Forge custom UI apps run in an iframe that
// auto-resizes to fit its content height, so `vh` here would be relative to
// that (unstable, content-dependent) iframe viewport rather than the user's
// actual browser window, which made an earlier `70vh` attempt never actually
// clip/scroll (the iframe just kept growing to fit everything, and the outer
// Jira page scrolled instead).
// ~50 body rows (BODY_CELL_HEIGHT each) fit before this box's own scrollbar
// kicks in, so a typical report shows its first ~50 users without needing to
// scroll at all. The header is no longer inside this box (see above), so it
// no longer needs to budget space for HEADER_CELL_HEIGHT.
//
// ---------------------------------------------------------------------------
// Keeping the two tables' columns aligned
//
// Atlaskit renders every DynamicTable's <table> at `width: 100%` (see
// @atlaskit/dynamic-table's table.compiled.css). Because the header and body
// are two separate tables (the frozen-header technique above), they only stay
// column-aligned while they resolve to the *exact* same width — and with
// `table-layout: auto`, any width difference gets redistributed across the
// columns, so even a small mismatch visibly skews every boundary. Two things
// have to hold:
//
//  1. Neither box may shrink to its content while the other stretches. An
//     earlier attempt used `width: 'fit-content'` here, which was fine when
//     the table was WIDER than the viewport (both ended up at content width)
//     but badly wrong when it was NARROWER: the header stretched to 100% of
//     the container while the body shrank to ~380px, throwing the columns out
//     by ~350px. `minWidth: 'fit-content'` is the correct form — it grows the
//     box past the container when the table is wide (so nothing is clipped
//     and the outer box does the scrolling) while still stretching normally
//     when the table is narrow.
//
//  2. Both boxes must reserve the SAME vertical-scrollbar gutter. The body
//     scrolls vertically and the header doesn't, so a bare `overflowY: 'auto'`
//     stole ~15px from the body's content width that the header still had —
//     leaving a residual ~10px column skew (measured). `'scroll'` (not
//     `'auto'`) on BOTH boxes reserves the gutter unconditionally on both
//     sides, so their content widths match exactly.
//
// The catch with (2) is that `overflowY: 'scroll'` paints a scrollbar track,
// complete with arrow buttons, beside BOTH tables at all times — including a
// completely inert one next to the header that scrolls nothing. On a short
// report that means two stacked scrollbars decorating a table that has no
// need to scroll at all. The obvious CSS answer, `scrollbarGutter: 'stable'`
// (reserve the space, don't paint the track), is not available: Forge's xcss
// only accepts a fixed allowlist of properties and `scrollbarGutter` isn't on
// it — it fails typecheck, and the runtime sanitises to the same list, so a
// cast wouldn't help either.
//
// So the vertical clip is applied CONDITIONALLY instead — see
// MAX_UNCLIPPED_BODY_ROWS and tableUnclippedBoxStyle below. A report short
// enough to fit gets no `maxHeight` and no `overflow` on either box, which
// means zero gutter on both (still trivially matched, since they then share
// one identical style) and no scrollbars anywhere. Only once the rows could
// actually overflow do both boxes switch to the clipped/`'scroll'` pair, at
// which point the scrollbar is genuinely doing something.
//
// `overflowX: 'hidden'` is what suppresses the duplicate horizontal
// scrollbar: specifying only `overflowY` leaves `overflow-x` as `visible`,
// and the CSS Overflow spec coerces `visible` to `auto` whenever the other
// axis is not `visible`, so each box silently grew its own horizontal
// scrollbar stacked above the outer one. That inner scrollbar was actively
// harmful, not mere clutter — it scrolled the body table alone, leaving the
// frozen header behind.
//
// Measured in Chrome across both regimes (3-column and 22-column reports,
// each with a short body that fits and a long body that overflows): worst
// column offset 0px in all four, header/body widths identical, nothing
// clipped, outer scroll intact. For contrast, the same four cases with a bare
// `overflowY: 'auto'` (no stable gutter) skew by ~10px as soon as the body
// starts scrolling.
// ---------------------------------------------------------------------------
const MAX_BODY_HEIGHT = '1650px';

const tableBodyVerticalScrollStyle = xcss({
  maxHeight: MAX_BODY_HEIGHT,
  overflowY: 'scroll',
  overflowX: 'hidden',
  minWidth: 'fit-content',
});

// Header counterpart of tableBodyVerticalScrollStyle. Holds no scrollable
// content of its own — it exists purely to reserve the same scrollbar gutter
// and obey the same width rules, so the header columns land exactly where the
// body columns do. See the comment block above.
const tableHeaderScrollGutterStyle = xcss({
  overflowY: 'scroll',
  overflowX: 'hidden',
  minWidth: 'fit-content',
});

// Used for BOTH the header and body boxes when the report is short enough
// that the body can't overflow MAX_BODY_HEIGHT — so there is nothing to
// scroll and no reason to paint (or reserve room for) a scrollbar. Sharing
// one identical style across both boxes makes their widths match by
// construction. No `overflow` of either axis is set on purpose: `overflowX:
// 'hidden'` alone would leave `overflow-y` as `visible`, which the CSS
// Overflow spec then coerces to `auto` — quietly reintroducing the very
// scrollbar this style exists to avoid. Leaving both axes `visible` lets the
// content spill out to be scrolled by the outer horizontal box instead, which
// is exactly what we want.
const tableUnclippedBoxStyle = xcss({
  minWidth: 'fit-content',
});

// Above this many rows the body switches to the clipped, vertically
// scrollable style pair. Derived from MAX_BODY_HEIGHT and the tallest a
// single body row can get: date/Total cells are BODY_CELL_HEIGHT (32px), but
// Project and Issue cells deliberately have no fixed height and wrap to two
// lines (~56px). At that worst case 1650px holds ~29 rows, so 25 leaves
// headroom while still covering the short reports this is really aimed at.
// Erring low is the safe direction — an unnecessary clip merely shows a
// working scrollbar, whereas clipping too late would hide rows outright.
const MAX_UNCLIPPED_BODY_ROWS = 25;

// The Worklog Detail popup's table scrolls rather than paginating. It used to
// carry DynamicTable's own pager (rowsPerPage={10}), which buried everything
// past the tenth worklog behind a control that's easy to miss — a drill-down
// is meant to be read straight through, and clicking a row's Total can now
// surface a whole period's worth of entries at once.
//
// A fixed px maxHeight rather than vh for the same reason the report table
// uses one: a Forge app renders in an iframe that resizes to its own content,
// so vh is relative to that unstable viewport rather than the real window.
// Both overflow axes are set explicitly — specifying only overflowY would
// leave overflow-x as `visible`, which the CSS Overflow spec then coerces to
// `auto` anyway, so being explicit just makes the intent readable.
const detailTableScrollStyle = xcss({
  maxHeight: '480px',
  overflowY: 'auto',
  overflowX: 'auto',
});

// Clickable header cell for the Project/Author columns (see handleSortClick).
// No padding/border of its own so it doesn't grow the fixed-height header Box
// around it. backgroundColor pinned to the surface colour for the same
// reason as dateValuePressableStyle below — an unstyled Pressable's native
// <button> background otherwise shows through as an unwanted grey patch.
const sortHeaderPressableStyle = xcss({
  padding: 'space.0',
  backgroundColor: 'elevation.surface',
});

// ---------------------------------------------------------------------------
// Column widths
//
// The frozen-header technique (see above) renders the header and body as two
// *separate* DynamicTable instances (each its own <table> element). Atlaskit
// DynamicTable normally keeps a table's own header/body columns aligned via
// an internal per-cell `width` it computes from the `head` prop — but that
// mechanism only works within a single DynamicTable (the body reads its
// column widths from ITS OWN `head` prop, which we intentionally pass as
// `undefined` on the body-only table so it doesn't render a duplicate header
// row). With no width hint, the body table's columns auto-size to its own
// (often much longer) cell content while the header table's columns
// auto-size to its own short header labels — two independent <table>s with
// no shared width, so their column boundaries drift apart, most visibly on
// the free-text group columns (Project/Author/Issues).
//
// The fix: give every column an explicit `width` (not just `minWidth`) via
// our own cell Boxes, combined with `overflow:hidden` — this pins both
// tables' column boundaries to the exact same pixel value regardless of
// either table's own content, so header and body always line up. (Forge's
// Box xcss only whitelists a fixed set of CSS properties — `whiteSpace`/
// `textOverflow` aren't among them, so long text wraps within the fixed-
// height cell and is clipped rather than ellipsis-truncated; acceptable
// since GROUP_COLUMN_WIDTH comfortably fits the vast majority of real
// project/user/issue labels on one line.)
const DATE_COLUMN_WIDTH = '92px';
const GROUP_COLUMN_WIDTH = '190px';
const TOTAL_COLUMN_WIDTH = '100px';
// Project names ("KEY: Full Project Name") run noticeably longer than
// Author/Epic/Status labels, and the Issue column now shows "KEY: <20-char
// summary>..." (see truncateSummary) — both get their own wider column
// instead of the default GROUP_COLUMN_WIDTH.
const PROJECT_COLUMN_WIDTH = '260px';
const ISSUE_COLUMN_WIDTH = '260px';

// Body rows are wrapped in a Box pinned to a fixed height for a consistent
// look across rows (a Lozenge vs. plain text can otherwise round to a
// different pixel height). The header table and body table are now separate
// DynamicTable instances (see tableHorizontalScrollStyle above), so this no
// longer needs to keep two tables' rows in lockstep — it's just visual
// consistency now.
const BODY_CELL_HEIGHT = '32px';
const bodyCellStyle = xcss({
  height: BODY_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  width: DATE_COLUMN_WIDTH,
});

// Group columns (Project/Author/Issues) and the Total column hold free-text
// / numeric content of varying length, so they get their own (wider) fixed
// width instead of the date columns' — see the "Column widths" comment above
// for why this must be `width`, not `minWidth`.
const bodyGroupCellStyle = xcss({
  height: BODY_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  width: GROUP_COLUMN_WIDTH,
});

// Project and Issue cells intentionally have NO fixed `height`/`overflow`
// (unlike bodyGroupCellStyle) — the whole point is that their full text is
// shown, never clipped. A project name that doesn't fit on one line simply
// wraps and the row grows to fit it (the table row's height is driven by its
// tallest cell either way, so the other fixed-height cells in that row just
// get a little breathing room, they aren't affected).
const bodyProjectCellStyle = xcss({
  display: 'block',
  width: PROJECT_COLUMN_WIDTH,
});

const bodyIssueCellStyle = xcss({
  display: 'block',
  width: ISSUE_COLUMN_WIDTH,
});

const bodyTotalCellStyle = xcss({
  height: BODY_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  width: TOTAL_COLUMN_WIDTH,
});

// No padding/border of its own (unlike Button) so a clickable date cell's row
// height matches the plain-Text cells around it.
//
// backgroundColor is set explicitly to 'elevation.surface' (pure white,
// matching the table's own background) rather than left unset. Pressable
// renders a real <button> under the hood, and an unstyled <button> keeps the
// browser's native control background (light grey) unless something
// overrides it — Atlaskit's own reset (appearance:none, border:none) doesn't
// reliably clear that background-color in every browser. Pinning it to the
// surface colour makes the button visually disappear into the cell, leaving
// only the coloured text, in every browser rather than depending on how
// completely a given browser strips native <button> chrome.
const dateValuePressableStyle = xcss({
  color: 'color.text.brand',
  backgroundColor: 'elevation.surface',
  padding: 'space.0',
});

// Red-text variant of dateValuePressableStyle — used instead of a red cell
// background when the date bucket has a worklog with a blank comment, so
// only the number itself is flagged (same visual treatment as the normal
// blue clickable value, just recolored).
const dateValueMissingCommentStyle = xcss({
  color: 'color.text.danger',
  backgroundColor: 'elevation.surface',
  padding: 'space.0',
});

// Grey background for weekend (Saturday/Sunday) date columns, denoting an
// off day / holiday. Kept at the same fixed height as bodyCellStyle.
const bodyCellWeekendStyle = xcss({
  height: BODY_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  width: DATE_COLUMN_WIDTH,
  backgroundColor: 'color.background.neutral',
});

// Header cells are pinned to a fixed height — the date columns' headers are
// two lines (e.g. day/date, month/year, quarter/year) while the group-column
// headers ("User", "Total") are one line, so this keeps every header cell in
// the (now single) header row the same height regardless of how many lines
// its own content uses.
//
// This was previously 40px, which was too short for two stacked lines of
// text (bold line + regular line) — the second line (e.g. the year in
// "Jul" / "2026" for the Month period) got silently clipped by this Box's
// own `overflow: hidden`. 56px comfortably fits two lines across every
// period (day/week/month/quarter/year) plus a little breathing room.
const HEADER_CELL_HEIGHT = '56px';
const headerCellStyle = xcss({
  height: HEADER_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  textAlign: 'center',
  width: DATE_COLUMN_WIDTH,
});

// Header counterparts of bodyGroupCellStyle/bodyTotalCellStyle — same widths
// as their body versions so the header and body tables' column boundaries
// always land in the same place (see the "Column widths" comment above).
const headerGroupCellStyle = xcss({
  height: HEADER_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  textAlign: 'center',
  width: GROUP_COLUMN_WIDTH,
});

// Header counterparts of bodyProjectCellStyle/bodyIssueCellStyle — the
// header's own text ("Project"/"Issue") is short and fits in one line
// regardless, so these keep the fixed HEADER_CELL_HEIGHT; only the width
// needs to match the body's wider columns for alignment.
const headerProjectCellStyle = xcss({
  height: HEADER_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  textAlign: 'center',
  width: PROJECT_COLUMN_WIDTH,
});

const headerIssueCellStyle = xcss({
  height: HEADER_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  textAlign: 'center',
  width: ISSUE_COLUMN_WIDTH,
});

const headerTotalCellStyle = xcss({
  height: HEADER_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  textAlign: 'center',
  width: TOTAL_COLUMN_WIDTH,
});

// Weekend variant of headerCellStyle — greys out Saturday/Sunday date column
// headers to match the grey body cells below them.
const headerCellWeekendStyle = xcss({
  height: HEADER_CELL_HEIGHT,
  overflow: 'hidden',
  display: 'block',
  textAlign: 'center',
  width: DATE_COLUMN_WIDTH,
  backgroundColor: 'color.background.neutral',
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Values here must match the resolver's dimension keys (src/resolvers/index.ts
// getDimensionLabel) — 'author' not 'user', or grouping silently falls through
// to the "Unknown" default case.
const DIMENSION_OPTIONS: SelectOption[] = [
  { label: 'User', value: 'author' },
  { label: 'Epic', value: 'epic' },
  { label: 'Issue Type', value: 'issueType' },
  { label: 'Status', value: 'status' },
  { label: 'Project', value: 'project' },
];

// Group by and 2nd Group can additionally break down by individual issue —
// the most granular dimension available. Categorize deliberately doesn't offer
// it: that's the outermost column, and one row per issue at the top level is
// just a flat worklog list rather than a pivot.
//
// The resolver already understands the 'issues' key (getDimensionLabel and the
// groupColumnHeaders switch both handle it), and the frontend already gives
// that dimension the wider issue column and the linked "KEY: summary" cell —
// see bodyStyleForDimension and the isIssueDimension branch in buildAllRows.
// So this is purely about which dropdowns offer it.
const GROUP_BY_OPTIONS: SelectOption[] = [
  ...DIMENSION_OPTIONS,
  { label: 'Issues', value: 'issues' },
];

// Derived from GROUP_BY_OPTIONS rather than restating the list, so the two
// dropdowns can't drift apart as dimensions are added.
const SECOND_GROUP_OPTIONS: SelectOption[] = [
  { label: 'None', value: '' },
  ...GROUP_BY_OPTIONS,
];

// Only Day/Week/Month are user-selectable. 'quarter', 'year' and 'custom'
// remain valid in WorklogReportRequest['period'] and are still handled end to
// end by the resolver (getPeriodBucketKey/generateDateLabels) and by
// formatDateHeaderLines — deliberately, so a preset saved before they were
// withdrawn still renders correctly rather than erroring. Loading such a
// preset falls back to Week, since handleLoadPreset can't match the value to
// an option here.
const PERIOD_OPTIONS: SelectOption[] = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
];

// Labels only — kept short ("Hrs:Min" rather than "Hours:Minutes") so the
// Time Unit field can sit in compactFieldStyle. `value` (what actually drives
// formatHours) is unchanged, so this is a display-only change.
const TIME_UNIT_OPTIONS: SelectOption[] = [
  { label: 'Decimal', value: 'decimal' },
  { label: 'Hrs:Min', value: 'hoursMinutes' },
];

// ---------------------------------------------------------------------------
// Multi-month date-range chunking
//
// No separate "months" UI control — a wide From/To range (e.g. a full
// 7-month span) is just entered in the existing date pickers as always, with
// whatever Period is selected. What changes is how it's *fetched*: a range
// spanning more than one calendar month is split into one request per
// calendar month and fetched in parallel (see fetchChunkedReport), instead of
// one long request paging sequentially through the entire range. Splitting
// on calendar-month boundaries (rather than, say, fixed day counts) means
// each chunk's own JQL/worklog fetch window is disjoint from every other
// chunk's — no worklog can ever be counted by two chunks — while a bucket
// that straddles a chunk boundary (e.g. an ISO week spanning Jan 29–Feb 4)
// still gets its correct total, since each side contributes its own partial
// hours under the same dateLabel and mergeReportChunks sums same-label
// contributions across chunks rather than assuming one column per chunk.
// ---------------------------------------------------------------------------

/** Splits [startDate, endDate] into calendar-month-bounded sub-ranges. A
 * range within a single month returns exactly one chunk (the original
 * range, unchanged) so small/typical reports never pay any chunking
 * overhead. */
export function splitIntoMonthChunks(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    chunks.push({
      start: cursor.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }

  return chunks;
}

/** Runs `fn` over `items` with at most `limit` in flight at once — caps the
 * fan-out for a pathological input (e.g. a multi-year range) while still
 * getting most of the parallelization benefit for realistic ranges (a few
 * months to a couple of years). */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Merges several chunk results (each independently fetched/paginated with
 * fetchFullReport over its own sub-range) into one report. Unlike mergeRows
 * (which assumes every batch shares the exact same dateLabels array, true
 * for pages within a single request), chunks can have different, only
 * partially-overlapping dateLabels — so this merges by dateLabel *value*
 * across the union of all chunks' labels, sorted chronologically (dateLabels
 * are always YYYY-MM-DD, so a plain string sort is already chronological).
 */
export function mergeReportChunks(
  chunks: Array<{ headers: string[]; rows: WorklogReportResponse['rows'] }>,
): { headers: string[]; rows: WorklogReportResponse['rows'] } {
  const headers = chunks.find((c) => c.headers.length > 0)?.headers ?? [];
  const dateLabelSet = new Set<string>();
  for (const chunk of chunks) {
    for (const row of chunk.rows) {
      for (const dh of row.dateHours) dateLabelSet.add(dh.dateLabel);
    }
  }
  const dateLabels = Array.from(dateLabelSet).sort();
  const labelIndex = new Map(dateLabels.map((label, idx) => [label, idx]));

  const rowMap = new Map<string, WorklogPivotRow>();
  for (const chunk of chunks) {
    for (const row of chunk.rows) {
      const groupKey = row.groupColumns.map((gc) => `${gc.dimension}::${gc.label}`).join('|||');
      let target = rowMap.get(groupKey);
      if (!target) {
        target = {
          groupColumns: row.groupColumns,
          dateHours: dateLabels.map((label) => ({ dateLabel: label, hours: 0, hasEmptyComment: false })),
          rowTotalHours: 0,
          issueKeys: [],
          rowHasEmptyComment: false,
        };
        rowMap.set(groupKey, target);
      }
      for (const dh of row.dateHours) {
        const idx = labelIndex.get(dh.dateLabel)!;
        target.dateHours[idx].hours = Math.round((target.dateHours[idx].hours + dh.hours) * 100) / 100;
        target.dateHours[idx].hasEmptyComment = target.dateHours[idx].hasEmptyComment || !!dh.hasEmptyComment;
      }
      target.rowHasEmptyComment = target.rowHasEmptyComment || !!row.rowHasEmptyComment;
      const keySet = new Set(target.issueKeys ?? []);
      for (const k of row.issueKeys ?? []) keySet.add(k);
      target.issueKeys = Array.from(keySet);
    }
  }

  const rows = Array.from(rowMap.values()).map((row) => ({
    ...row,
    rowTotalHours: Math.round(row.dateHours.reduce((sum, dh) => sum + dh.hours, 0) * 100) / 100,
  }));

  return { headers, rows: sortRowsByFirstGroupColumn(rows) };
}

// ---------------------------------------------------------------------------
// Auto-detect browser time zone (no UI control — passed silently in requests)
// ---------------------------------------------------------------------------
function detectTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Mirrors JQL_ERROR_PREFIX in src/resolvers/index.ts — kept as a literal
 * rather than imported, since importing the resolver module into the frontend
 * bundle would pull in @forge/api (a backend-only dependency). */
const JQL_ERROR_PREFIX = 'Invalid search query: ';

/**
 * Picks the message to show for a failed report/export. A bad JQL query is
 * the user's to fix and Jira tells us exactly what's wrong, so that detail is
 * passed through verbatim; anything else (network, permissions, timeouts) gets
 * the generic fallback, since its internals aren't actionable for the user.
 */
function describeReportError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const idx = message.indexOf(JQL_ERROR_PREFIX);
  if (idx === -1) return fallback;
  const detail = message.slice(idx + JQL_ERROR_PREFIX.length).trim();
  return detail ? `Invalid JQL — ${detail}` : 'Invalid JQL. Please check your query.';
}

/** Formats a raw ISO worklog-created timestamp as "dd-mm-yyyy HH:mm" in the
 * given time zone — consistent with the app's dd-mm-yyyy date convention
 * used elsewhere (date-column headers, CSV export). */
function formatCreatedDate(iso: string, timeZone: string): string {
  if (!iso) return '-';
  try {
    const dt = new Date(iso);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(dt);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.day}-${map.month}-${map.year} ${map.hour}:${map.minute}`;
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Mock data for preview mode
// ---------------------------------------------------------------------------
const MOCK_FILTER_OPTIONS: FilterOptions = {
  projects: [
    { key: 'PROJ', name: 'Project Alpha' },
    { key: 'DEV', name: 'Development' },
    { key: 'OPS', name: 'Operations' },
  ],
  users: [
    { accountId: 'user-1', displayName: 'Alice Johnson' },
    { accountId: 'user-2', displayName: 'Bob Smith' },
    { accountId: 'user-3', displayName: 'Carol Lee' },
  ],
  epics: [
    { key: 'PROJ-10', summary: 'Q3 Redesign' },
    { key: 'DEV-5', summary: 'API Migration' },
  ],
  issueTypes: ['Bug', 'Task', 'Story', 'Epic'],
};

const MOCK_PRESETS: FilterPreset[] = [
  {
    name: 'Weekly Team Report',
    projectKeys: ['PROJ'],
    startDate: '2026-08-01',
    endDate: '2026-08-07',
    period: 'week',
    categorize: 'author',
    timeUnit: 'decimal',
    timeZone: 'UTC',
    grandTotal: true,
  },
];

const MOCK_REPORT: WorklogReportResponse = {
  groupColumnHeaders: ['User'],
  nextPageToken: null,
  isComplete: true,
  progress: { loadedIssues: 3, totalIssues: 3 },
  rows: [
    {
      groupColumns: [{ dimension: 'author', label: 'Alice Johnson' }],
      dateHours: [
        { dateLabel: 'Aug 4', hours: 6.5 },
        { dateLabel: 'Aug 5', hours: 7.25 },
        { dateLabel: 'Aug 6', hours: 8 },
        { dateLabel: 'Aug 7', hours: 5.75 },
        { dateLabel: 'Aug 8', hours: 4 },
      ],
      rowTotalHours: 31.5,
    },
    {
      groupColumns: [{ dimension: 'author', label: 'Bob Smith' }],
      dateHours: [
        { dateLabel: 'Aug 4', hours: 8 },
        { dateLabel: 'Aug 5', hours: 7 },
        { dateLabel: 'Aug 6', hours: 6 },
        { dateLabel: 'Aug 7', hours: 8 },
        { dateLabel: 'Aug 8', hours: 7.5 },
      ],
      rowTotalHours: 36.5,
    },
    {
      groupColumns: [{ dimension: 'author', label: 'Carol Lee' }],
      dateHours: [
        { dateLabel: 'Aug 4', hours: 4.25 },
        { dateLabel: 'Aug 5', hours: 5 },
        { dateLabel: 'Aug 6', hours: 3.5 },
        { dateLabel: 'Aug 7', hours: 6 },
        { dateLabel: 'Aug 8', hours: 5.25 },
      ],
      rowTotalHours: 24,
    },
  ],
  grandTotal: {
    dateHours: [
      { dateLabel: 'Aug 4', hours: 18.75 },
      { dateLabel: 'Aug 5', hours: 19.25 },
      { dateLabel: 'Aug 6', hours: 17.5 },
      { dateLabel: 'Aug 7', hours: 19.75 },
      { dateLabel: 'Aug 8', hours: 16.75 },
    ],
    grandTotalHours: 92,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getFirstDayOfMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function getTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatHours(hours: number, unit: string): string {
  if (unit === 'hoursMinutes') {
    const h = Math.floor(hours);
    const mins = Math.round((hours - h) * 60);
    return `${h}:${String(mins).padStart(2, '0')}`;
  }
  return hours.toFixed(2);
}

// Picks the wider Project/Issue cell style for those two dimensions and
// falls back to the default group-column style (Author/Epic/Status/Issue
// Type) otherwise — used for both the header and body tables so a given
// column index always renders at the same width in both (see the "Column
// widths" comment near the style definitions).
function bodyStyleForDimension(dimension: string | undefined): XCSSObject {
  if (dimension === 'project') return bodyProjectCellStyle;
  if (dimension === 'issue' || dimension === 'issues') return bodyIssueCellStyle;
  return bodyGroupCellStyle;
}

function headerStyleForDimension(dimension: string | undefined): XCSSObject {
  if (dimension === 'project') return headerProjectCellStyle;
  if (dimension === 'issue' || dimension === 'issues') return headerIssueCellStyle;
  return headerGroupCellStyle;
}

/** Max characters of the issue *summary* portion shown in the Issue column
 * before it's cut off with "…" — the issue key itself is never truncated.
 * Per-user request: full summaries are still one click away (the label is
 * now a hyperlink straight to the issue). */
const ISSUE_SUMMARY_MAX_CHARS = 20;

/**
 * Splits a resolver-built "issue" dimension label ("KEY: Summary text") into
 * its issue key (for the /browse/ link) and a display string with the
 * summary truncated to ISSUE_SUMMARY_MAX_CHARS. Labels that don't match the
 * "KEY: " shape (shouldn't happen for the issue dimension, but guards
 * against an unexpected resolver change) are returned unmodified with no key.
 */
function formatIssueLabel(label: string): { key: string | null; display: string } {
  const separatorIndex = label.indexOf(': ');
  if (separatorIndex === -1) return { key: null, display: label };
  const key = label.slice(0, separatorIndex);
  const summary = label.slice(separatorIndex + 2);
  const truncatedSummary =
    summary.length > ISSUE_SUMMARY_MAX_CHARS ? `${summary.slice(0, ISSUE_SUMMARY_MAX_CHARS)}...` : summary;
  return { key, display: `${key}: ${truncatedSummary}` };
}

const FE_SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FE_SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Mirrors the resolver's formatDateHeader (src/resolvers/index.ts) — dateLabel
// is the bucket's start day (a whole week/month/etc. when period isn't 'day').
// Returns two lines so every date-column header renders the same shape
// ("Sat" / "01 Aug") regardless of period.
function formatDateHeaderLines(dateLabel: string, period: WorklogReportRequest['period']): [string, string] {
  const d = new Date(dateLabel + 'T00:00:00Z');
  switch (period) {
    case 'week': {
      const weekEnd = new Date(d);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      const start = `${String(d.getUTCDate()).padStart(2, '0')} ${FE_SHORT_MONTHS[d.getUTCMonth()]}`;
      const end = `${String(weekEnd.getUTCDate()).padStart(2, '0')} ${FE_SHORT_MONTHS[weekEnd.getUTCMonth()]}`;
      return [start, `to ${end}`];
    }
    case 'month':
      return [FE_SHORT_MONTHS[d.getUTCMonth()], `${d.getUTCFullYear()}`];
    case 'quarter':
      return [`Q${Math.floor(d.getUTCMonth() / 3) + 1}`, `${d.getUTCFullYear()}`];
    case 'year':
      return [`${d.getUTCFullYear()}`, ''];
    case 'day':
    case 'custom':
    default: {
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = d.getUTCFullYear();
      // Weekday on the second line, matching the resolver's CSV header
      // ("Mon 17-Aug"). Uses getUTCDay to stay consistent with the UTC
      // parse above and with isWeekendBucket's weekend shading.
      return [`${dd}-${mm}-${yyyy}`, FE_SHORT_DAYS[d.getUTCDay()]];
    }
  }
}

// Weekends only make sense as a concept for single-day buckets — a 'week' or
// 'month' bucket spans both weekend and weekday worklogs, so this only
// returns true for 'day'/'custom' periods.
function isWeekendBucket(dateLabel: string, period: WorklogReportRequest['period']): boolean {
  if (period !== 'day' && period !== 'custom') return false;
  const d = new Date(dateLabel + 'T00:00:00Z');
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/** Merge rows from a new batch into the accumulated rows */
function mergeRows(existing: WorklogReportResponse['rows'], incoming: WorklogReportResponse['rows']): WorklogReportResponse['rows'] {
  const merged = [...existing];
  for (const row of incoming) {
    const groupKey = row.groupColumns.map((gc) => `${gc.dimension}::${gc.label}`).join('|||');
    const found = merged.find(
      (r) => r.groupColumns.map((gc) => `${gc.dimension}::${gc.label}`).join('|||') === groupKey,
    );
    if (found) {
      for (let i = 0; i < row.dateHours.length; i++) {
        if (i < found.dateHours.length) {
          found.dateHours[i].hours = Math.round((found.dateHours[i].hours + row.dateHours[i].hours) * 100) / 100;
          found.dateHours[i].hasEmptyComment = found.dateHours[i].hasEmptyComment || row.dateHours[i].hasEmptyComment;
        }
      }
      found.rowTotalHours = Math.round(found.dateHours.reduce((sum, d) => sum + d.hours, 0) * 100) / 100;
      found.rowHasEmptyComment = found.rowHasEmptyComment || row.rowHasEmptyComment;
      // Merge issueKeys
      const keySet = new Set(found.issueKeys ?? []);
      for (const k of row.issueKeys ?? []) keySet.add(k);
      found.issueKeys = Array.from(keySet);
    } else {
      merged.push({ ...row, dateHours: row.dateHours.map((dh) => ({ ...dh })) });
    }
  }
  return merged;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * A UTF-8 byte-order mark. Prepending this to CSV text is NOT optional.
 *
 * Excel opens a .csv from disk using the machine's ANSI codepage
 * (Windows-1252 on a typical install) unless the file begins with a BOM — it
 * ignores the Blob's `charset=utf-8` MIME parameter entirely, because by the
 * time the user double-clicks the downloaded file there is no MIME type left
 * to consult. Without the BOM every non-ASCII character is decoded one byte
 * at a time and arrives mangled ("mojibake"): an en dash (U+2013, UTF-8
 * `E2 80 93`) renders as `â€"`, a curly apostrophe (U+2019) as `â€™`.
 *
 * That is not hypothetical here — Jira issue summaries and worklog comments
 * routinely contain both. A real summary, "Jira Worklog Reporting App (Forge)
 * – Developer Instructions & Technical Spec - Phase 2", exported as
 * "...(Forge) â€" Developer Instructions...".
 */
// Written as an escape, not the literal character, so it stays visible to
// anyone reading this file and can't be silently stripped by an editor.
const UTF8_BOM = '\uFEFF';

/** The exact bytes that go into the downloaded file. Split out from
 * downloadCsv (which needs a DOM) purely so the encoding is unit-testable. */
export function encodeCsvForDownload(csvContent: string): string {
  return UTF8_BOM + csvContent;
}

/**
 * Trigger a browser download of CSV text, correctly encoded.
 *
 * Shared by both exports so the BOM can't be remembered in one and forgotten
 * in the other — which is exactly how the mojibake above got shipped.
 */
function downloadCsv(csvContent: string, filename: string): void {
  const blob = new Blob([encodeCsvForDownload(csvContent)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Compute grand total from merged rows */
function computeGrandTotal(rows: WorklogReportResponse['rows']): WorklogReportResponse['grandTotal'] {
  if (rows.length === 0) return null;
  const dateLabels = rows[0].dateHours.map((dh) => dh.dateLabel);
  const totalMap = new Map<string, number>();
  for (const row of rows) {
    for (const dh of row.dateHours) {
      totalMap.set(dh.dateLabel, (totalMap.get(dh.dateLabel) ?? 0) + dh.hours);
    }
  }
  const dateHours = dateLabels.map((label) => ({
    dateLabel: label,
    hours: Math.round((totalMap.get(label) ?? 0) * 100) / 100,
  }));
  const grandTotalHours = Math.round(dateHours.reduce((sum, d) => sum + d.hours, 0) * 100) / 100;
  return { dateHours, grandTotalHours };
}

/** Sorts rows by their first group column label — mirrors the resolver's
 * default row order (src/resolvers/index.ts buildReportData). */
function sortRowsByFirstGroupColumn(rows: WorklogReportResponse['rows']): WorklogReportResponse['rows'] {
  return [...rows].sort((a, b) => {
    for (let i = 0; i < Math.min(a.groupColumns.length, b.groupColumns.length); i++) {
      const cmp = a.groupColumns[i].label.localeCompare(b.groupColumns[i].label);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

/**
 * Pages through getWorklogReport for a single request until complete,
 * merging batches with mergeRows — the same loop "View Report" and
 * "Export CSV" already ran inline (now shared, and reused once per
 * calendar-month chunk for wide date ranges too — see fetchChunkedReport).
 */
async function fetchFullReport(
  req: WorklogReportRequest,
  onProgress?: (loadedSoFar: number) => void,
): Promise<{ headers: string[]; rows: WorklogReportResponse['rows']; loadedIssues: number; totalIssues: number }> {
  let accumulatedRows: WorklogReportResponse['rows'] = [];
  let headers: string[] = [];
  let pageToken: string | undefined;
  let totalLoaded = 0;
  let totalIssues = 0;

  while (true) {
    const payload = pageToken ? { ...req, pageToken } : req;
    const res = await invoke<WorklogReportResponse>('getWorklogReport', payload);
    const batch = res ?? {
      groupColumnHeaders: [],
      rows: [],
      grandTotal: null,
      nextPageToken: null,
      isComplete: true,
      progress: { loadedIssues: 0, totalIssues: 0 },
    };

    headers = batch.groupColumnHeaders;
    accumulatedRows = mergeRows(accumulatedRows, batch.rows);
    totalLoaded += batch.progress.loadedIssues;
    totalIssues = batch.progress.totalIssues;
    onProgress?.(totalLoaded);

    if (batch.isComplete || !batch.nextPageToken) break;
    pageToken = batch.nextPageToken;
  }

  return { headers, rows: accumulatedRows, loadedIssues: totalLoaded, totalIssues };
}

/**
 * Fetches a report over an arbitrarily wide [startDate, endDate] range,
 * transparently splitting it into calendar-month chunks fetched in parallel
 * (mapWithConcurrency) when it spans more than one month, and merging the
 * results (mergeReportChunks). A range within a single month is a single
 * chunk, so this is a drop-in replacement for a plain fetchFullReport call
 * with no extra overhead for typical single-month/week/day reports.
 */
export async function fetchChunkedReport(
  req: WorklogReportRequest,
  onProgress?: (loadedSoFar: number) => void,
): Promise<{ headers: string[]; rows: WorklogReportResponse['rows']; loadedIssues: number; totalIssues: number }> {
  const ranges = splitIntoMonthChunks(req.startDate, req.endDate);
  if (ranges.length <= 1) {
    return fetchFullReport(req, onProgress);
  }

  const loadedPerChunk = new Array(ranges.length).fill(0);
  const chunkResults = await mapWithConcurrency(ranges, 6, async (range, idx) => {
    const chunkReq: WorklogReportRequest = { ...req, startDate: range.start, endDate: range.end };
    const result = await fetchFullReport(chunkReq, (loaded) => {
      loadedPerChunk[idx] = loaded;
      onProgress?.(loadedPerChunk.reduce((sum, n) => sum + n, 0));
    });
    return result;
  });

  const merged = mergeReportChunks(chunkResults);
  return {
    headers: merged.headers,
    rows: merged.rows,
    loadedIssues: chunkResults.reduce((sum, c) => sum + c.loadedIssues, 0),
    totalIssues: chunkResults.reduce((sum, c) => sum + c.totalIssues, 0),
  };
}

/**
 * Render a worklog comment as stacked lines, preserving the bullet markers and
 * indentation the resolver produced from the comment's ADF (see
 * extractWorklogComment) so the popup shows the list the author actually wrote.
 *
 * Two details make this less trivial than splitting on newlines:
 *  - A single Text node would collapse the newlines entirely, running every
 *    bullet into one paragraph — hence one Text per line.
 *  - HTML also collapses *leading* runs of whitespace, which would drag every
 *    nested bullet back to the left margin and lose the nesting. The indent is
 *    therefore re-emitted as non-breaking spaces, which survive collapsing.
 */
function renderCommentLines(text: string): JSX.Element {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return <Text>-</Text>;

  const lines = trimmed.split('\n');
  return (
    <Stack space="space.0">
      {lines.map((line, idx) => {
        const body = line.trimStart();
        // A blank line still needs a glyph, or it collapses to nothing and the
        // paragraph break the author intended disappears.
        if (!body) return <Text key={idx}>{'\u00A0'}</Text>;
        const indent = line.length - body.length;
        return <Text key={idx}>{'\u00A0'.repeat(indent) + body}</Text>;
      })}
    </Stack>
  );
}

/**
 * Assemble the "Export Comments" CSV: one row per worklog, plus a trailing
 * Total row so the file can be reconciled against the report's grand total at
 * a glance.
 *
 * Pure and exported so the escaping is actually testable — worklog comments
 * are free text and routinely contain commas, quotes and newlines, any one of
 * which silently corrupts every following column if it isn't escaped.
 */
export function buildCommentsCsv(entries: WorklogExportEntry[]): string {
  // Sorted so the file reads chronologically per person, which is how these
  // get reviewed — rather than in the issue-key order the pages arrive in.
  const sorted = [...entries].sort(
    (a, b) =>
      a.authorDisplayName.localeCompare(b.authorDisplayName) ||
      a.loggedDate.localeCompare(b.loggedDate) ||
      a.issueKey.localeCompare(b.issueKey),
  );

  const headerFields = [
    'Author',
    'Date Logged',
    'Project',
    'Issue Key',
    'Issue Summary',
    'Issue Type',
    'Hours',
    'Comment',
    'Worklog Created Date',
  ];
  const csvRows: string[] = [headerFields.map(csvEscape).join(',')];

  for (const e of sorted) {
    csvRows.push(
      [
        csvEscape(e.authorDisplayName),
        csvEscape(e.loggedDate),
        csvEscape(e.projectKey),
        csvEscape(e.issueKey),
        csvEscape(e.issueSummary),
        csvEscape(e.issueType),
        csvEscape(String(e.timeSpentHours)),
        csvEscape(e.comment),
        csvEscape(e.createdDate),
      ].join(','),
    );
  }

  const totalHours = Math.round(sorted.reduce((sum, e) => sum + e.timeSpentHours, 0) * 100) / 100;
  csvRows.push(['Total', '', '', '', '', '', csvEscape(String(totalHours)), '', ''].join(','));

  return csvRows.join('\n');
}

/**
 * Pages through getWorklogEntriesPage until complete, for one request.
 * The flat-worklog counterpart to fetchFullReport, and paged for the same
 * reason: one resolver call per page keeps every invocation well inside
 * Forge's 25-second function timeout.
 */
async function fetchAllWorklogEntriesForRange(
  req: WorklogReportRequest,
  onProgress?: (loadedSoFar: number) => void,
): Promise<WorklogExportEntry[]> {
  const entries: WorklogExportEntry[] = [];
  let pageToken: string | undefined;
  let totalLoaded = 0;

  while (true) {
    const payload = pageToken ? { ...req, pageToken } : req;
    const res = await invoke<WorklogEntriesResponse>('getWorklogEntriesPage', payload);
    const batch = res ?? {
      entries: [],
      nextPageToken: null,
      isComplete: true,
      progress: { loadedIssues: 0, totalIssues: 0 },
    };

    entries.push(...batch.entries);
    totalLoaded += batch.progress.loadedIssues;
    onProgress?.(totalLoaded);

    if (batch.isComplete || !batch.nextPageToken) break;
    pageToken = batch.nextPageToken;
  }

  return entries;
}

/**
 * Every worklog (with its comment) the report covers, over an arbitrarily wide
 * date range — month-chunked and parallelised exactly like fetchChunkedReport,
 * so a year-long comments export behaves like a year-long report rather than
 * timing out. Chunks partition the range, so unlike the report's rows the
 * results just concatenate: no merging, a worklog belongs to exactly one month.
 */
export async function fetchAllWorklogEntries(
  req: WorklogReportRequest,
  onProgress?: (loadedSoFar: number) => void,
): Promise<WorklogExportEntry[]> {
  const ranges = splitIntoMonthChunks(req.startDate, req.endDate);
  if (ranges.length <= 1) {
    return fetchAllWorklogEntriesForRange(req, onProgress);
  }

  const loadedPerChunk = new Array(ranges.length).fill(0);
  const chunkResults = await mapWithConcurrency(ranges, 6, async (range, idx) => {
    const chunkReq: WorklogReportRequest = { ...req, startDate: range.start, endDate: range.end };
    return fetchAllWorklogEntriesForRange(chunkReq, (loaded) => {
      loadedPerChunk[idx] = loaded;
      onProgress?.(loadedPerChunk.reduce((sum, n) => sum + n, 0));
    });
  });

  return chunkResults.flat();
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------
export const App = (): JSX.Element => {
  // Filter options & presets
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [initLoading, setInitLoading] = useState(true);

  // Toolbar state
  const [selectedPreset, setSelectedPreset] = useState<SelectOption | null>(null);
  const [selectedProjects, setSelectedProjects] = useState<SelectOption[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<SelectOption[]>([]);
  // Raw JQL entered by the user. When non-blank it overrides the Projects and
  // Users filters (both here and in the resolver — see buildRequest/buildJql),
  // and those two controls are disabled to make the precedence obvious rather
  // than leaving them looking active but inert.
  const [jqlFilter, setJqlFilter] = useState('');
  /** True when the JQL box holds a real query, i.e. it takes precedence. */
  const isJqlActive = jqlFilter.trim().length > 0;
  const [startDate, setStartDate] = useState(getFirstDayOfMonth());
  const [endDate, setEndDate] = useState(getTodayDate());
  const [period, setPeriod] = useState<SelectOption>({ label: 'Week', value: 'week' });
  const [categorize, setCategorize] = useState<SelectOption>({ label: 'User', value: 'author' });
  const [groupBy, setGroupBy] = useState<SelectOption | null>(null);
  const [secondGroup, setSecondGroup] = useState<SelectOption>({ label: 'None', value: '' });
  const [timeUnit, setTimeUnit] = useState<SelectOption>({ label: 'Decimal', value: 'decimal' });
  // Time zone is auto-detected, no UI state needed
  // The report always shows a totals row now, so this is no longer a
  // user-facing toggle — it's just always sent as true.

  // Shows/hides the per-group subtotal rows (e.g. one "Total" row per Author
  // when 2nd Group = Issues) — on by default, purely a client-side display
  // toggle over the already-fetched rows (see buildAllRows), so unchecking
  // it doesn't require a re-fetch.
  const [groupTotalEnabled, setGroupTotalEnabled] = useState(true);

  // Column sort — Project/Author columns only (see buildHead/handleSortClick).
  // Applied entirely client-side (sorting the already-fetched rows) rather
  // than via DynamicTable's own isSortable/built-in sort, which Forge's
  // wrapper doesn't expose a callback for (@atlaskit/dynamic-table sorts its
  // *own* internal row state on click regardless), so it can't be observed,
  // synchronized with data, or reset by our own code.
  const [sortColumn, setSortColumn] = useState<{ index: number; direction: 'asc' | 'desc' } | null>(null);

  // Report state
  const [report, setReport] = useState<WorklogReportResponse | null>(null);
  // The period the *displayed* report was actually fetched with — kept
  // separate from the live `period` toolbar state so date-column headers
  // don't misinterpret bucket keys if the dropdown changes before the next
  // "View Report" click.
  const [reportPeriod, setReportPeriod] = useState<WorklogReportRequest['period']>('week');
  // The date range the *displayed* report was actually fetched with — kept
  // separate from the live startDate/endDate toolbar state for the same
  // reason reportPeriod is kept separate from `period` (so it can't drift
  // out of sync with what's on screen if the pickers change before the next
  // "View Report" click). Used by the Worklog Detail popup's fetch window.
  const [reportDateRange, setReportDateRange] = useState<{ start: string; end: string }>({
    start: startDate,
    end: endDate,
  });
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);

  // Batched loading progress state — just a running count. Jira's search API
  // doesn't return a reliable total for these JQL queries (it's an estimate
  // that can be lower than the actual number of matching issues, e.g. showing
  // "Loaded 150 of 50"), so there's no trustworthy denominator to show.
  const [loadedCount, setLoadedCount] = useState<number | null>(null);

  // CSV export now pages through getWorklogReport client-side (see
  // handleExportCsv), so it can take a few seconds for a large date range —
  // this disables the button and swaps its label while that's in flight.
  const [csvExporting, setCsvExporting] = useState(false);
  const [commentsExporting, setCommentsExporting] = useState(false);

  // Worklog detail modal state
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [detailEntries, setDetailEntries] = useState<WorklogDetailEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Ref to track report data for drill-down (avoids stale closures)
  const reportRef = useRef<WorklogReportResponse | null>(null);

  // Cache of full-range Worklog Detail fetches, keyed by everything EXCEPT
  // the clicked date cell's bucket — see handleCellClick. Cleared whenever a
  // new report is generated, since issueKeys/filters may have changed.
  const detailCacheRef = useRef<Map<string, WorklogDetailEntry[]>>(new Map());

  // Set as soon as the user picks a Period themselves. The stored preference
  // is fetched asynchronously on mount, so without this the response could
  // land *after* an early interaction and yank the dropdown back to the
  // remembered value under the user's hands.
  const periodTouchedRef = useRef(false);

  // Remember the chosen Period for next time. Deliberately fire-and-forget:
  // the dropdown has already updated locally, so a storage hiccup should cost
  // the user nothing more than the setting not sticking — it must never block
  // the interaction or surface an error banner over a report they can see.
  const persistPeriod = useCallback((value: string) => {
    if (isAppBuilderPreview) return;
    invoke('saveUserPreferences', { period: value }).catch((err) => {
      console.warn('Failed to save period preference:', err);
    });
  }, []);

  // ------------------------------------------------------------------
  // Load initial data
  // ------------------------------------------------------------------
  useEffect(() => {
    setupGlobalErrorHandlers();

    const loadInitialData = async () => {
      try {
        let options: FilterOptions;
        let presetsResp: FilterPresetsResponse;

        if (isAppBuilderPreview) {
          options = MOCK_FILTER_OPTIONS;
          presetsResp = { presets: MOCK_PRESETS };
        } else {
          const [optRes, presetRes, prefsRes] = await Promise.all([
            invoke<FilterOptions>('getFilterOptions'),
            invoke<FilterPresetsResponse>('getFilterPresets'),
            // Never let a preferences failure take the whole toolbar down —
            // a remembered Period is a nicety, the filter options are not.
            invoke<UserPreferences>('getUserPreferences').catch((err) => {
              console.warn('Failed to load user preferences:', err);
              return {} as UserPreferences;
            }),
          ]);
          options = optRes ?? { projects: [], users: [], epics: [], issueTypes: [] };
          presetsResp = presetRes ?? { presets: [] };

          // Restore the Period the user last chose. Skipped if they already
          // picked one while this was in flight (see periodTouchedRef), and
          // skipped if the stored value is no longer an offered option —
          // Quarter/Year/Custom were removed from PERIOD_OPTIONS and may
          // still be sitting in an older user's storage.
          const storedPeriod = prefsRes?.period;
          if (storedPeriod && !periodTouchedRef.current) {
            const match = PERIOD_OPTIONS.find((o) => o.value === storedPeriod);
            if (match) setPeriod(match);
          }
        }

        setFilterOptions(options);
        const presetList = Array.isArray(presetsResp?.presets) ? presetsResp.presets : [];
        setPresets(presetList);
      } catch (err) {
        console.error('Failed to load filter options:', err);
        logError({ message: 'Failed to load filter options', stack: String(err) });
        setError('Failed to load filter options. Please try refreshing.');
      } finally {
        setInitLoading(false);
      }
    };

    loadInitialData();
  }, []);

  // ------------------------------------------------------------------
  // Build request from toolbar state
  // ------------------------------------------------------------------
  const buildRequest = useCallback((): WorklogReportRequest => {
    // The three dimension dropdowns are independent, so nothing stops the same
    // dimension being chosen in two of them — now easier to hit, since Issues
    // appears in both Group by and 2nd Group. A repeated dimension would just
    // render the same column twice with identical values in every row, so keep
    // the first occurrence and drop the rest.
    const groupByArr = [categorize?.value, groupBy?.value, secondGroup?.value]
      .filter((value): value is string => Boolean(value))
      .filter((value, idx, all) => all.indexOf(value) === idx);

    // A JQL query overrides the Projects and Users filters (the resolver
    // enforces the same precedence — see buildJql). They're omitted from the
    // request entirely rather than just ignored server-side, so what's sent
    // matches exactly what the report reflects.
    const trimmedJql = jqlFilter.trim();

    const filters: WorklogReportRequest['filters'] = {};
    if (!trimmedJql && selectedUsers.length > 0) {
      filters.authors = selectedUsers.map((u) => u.value);
    }

    return {
      projectKeys: trimmedJql ? [] : selectedProjects.map((p) => p.value),
      startDate,
      endDate,
      period: period.value as WorklogReportRequest['period'],
      groupBy: groupByArr.length > 0 ? groupByArr : undefined,
      jql: trimmedJql || undefined,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      timeUnit: timeUnit.value as 'decimal' | 'hoursMinutes',
      timeZone: detectTimeZone(),
      // Always requested now — the report always shows a totals row.
      grandTotal: true,
    };
  }, [selectedProjects, selectedUsers, startDate, endDate, period, categorize, groupBy, secondGroup, timeUnit, jqlFilter]);

  // ------------------------------------------------------------------
  // Validate toolbar
  // ------------------------------------------------------------------
  const validate = useCallback((): string[] => {
    const errs: string[] = [];
    if (!startDate) {
      errs.push('From date is required.');
    }
    if (!endDate) {
      errs.push('To date is required.');
    }
    if (startDate && endDate && endDate < startDate) {
      errs.push('To date must not precede From date.');
    }
    return errs;
  }, [startDate, endDate]);

  // ------------------------------------------------------------------
  // View Report
  // ------------------------------------------------------------------
  const handleViewReport = useCallback(async () => {
    const errs = validate();
    setValidationErrors(errs);
    if (errs.length > 0) return;

    setError(null);
    setReportLoading(true);
    setLoadedCount(null);
    setReport(null);
    setSortColumn(null);
    reportRef.current = null;
    detailCacheRef.current.clear();
    try {
      if (isAppBuilderPreview) {
        setReport(MOCK_REPORT);
        reportRef.current = MOCK_REPORT;
        setReportPeriod(period.value as WorklogReportRequest['period']);
        setReportDateRange({ start: startDate, end: endDate });
      } else {
        const req = buildRequest();
        setReportPeriod(req.period);
        setReportDateRange({ start: req.startDate, end: req.endDate });
        // A range spanning more than one calendar month is transparently
        // split into per-month chunks and fetched in parallel — see
        // fetchChunkedReport. A single-month range (the common case) is a
        // single chunk, so this has no extra overhead over the old direct
        // fetchFullReport call.
        const { headers, rows, loadedIssues, totalIssues } = await fetchChunkedReport(req, setLoadedCount);
        const gt = rows.length > 0 ? computeGrandTotal(rows) : null;
        const finalReport: WorklogReportResponse = {
          groupColumnHeaders: headers,
          rows,
          grandTotal: gt,
          nextPageToken: null,
          isComplete: true,
          progress: { loadedIssues, totalIssues },
        };
        setReport(finalReport);
        reportRef.current = finalReport;
      }
    } catch (err) {
      console.error('Failed to load report:', err);
      logError({ message: 'Failed to load worklog report', stack: String(err) });
      setError(describeReportError(err, 'Failed to load the worklog report. Please try again.'));
    } finally {
      setReportLoading(false);
      setLoadedCount(null);
    }
  }, [validate, buildRequest, period, startDate, endDate]);

  // ------------------------------------------------------------------
  // Export CSV
  // ------------------------------------------------------------------
  const handleExportCsv = useCallback(async () => {
    const errs = validate();
    setValidationErrors(errs);
    if (errs.length > 0) return;

    setError(null);
    setCsvExporting(true);
    try {
      let csvData: CsvExportResponse;
      if (isAppBuilderPreview) {
        csvData = { csvContent: 'User,Total\nAlice,31.50\nBob,36.50', filename: 'worklog-report.csv' };
      } else {
        // Built entirely client-side by paging through getWorklogReport (the
        // same call "View Report" uses via fetchChunkedReport) instead of a
        // single exportWorklogReport invocation. The old server-side export
        // ran its own full pagination loop inside one resolver call, which
        // for a large date range / no filters comfortably blew past Forge's
        // 25-second function timeout ("Function timed out. Limit of 25.00
        // seconds", confirmed via forge logs) and always failed with
        // "Failed to export CSV". Paging from the client keeps every
        // individual invocation short, exactly like the report view does —
        // and a wide date range is chunked/parallelized the same way too.
        const req = buildRequest();
        const { headers, rows } = await fetchChunkedReport(req);
        const exportPeriod = req.period;
        const rangeLabel = `${req.startDate}-to-${req.endDate}`;

        if (rows.length === 0) {
          throw new Error('No data to export - the report is empty');
        }

        const grandTotal = computeGrandTotal(rows);
        const dateLabels = rows[0].dateHours.map((dh) => dh.dateLabel);

        const headerFields = [
          ...headers,
          'Total',
          ...dateLabels.map((label) => {
            const [line1, line2] = formatDateHeaderLines(label, exportPeriod);
            return line2 ? `${line1} ${line2}` : line1;
          }),
        ];
        const csvRows: string[] = [headerFields.map(csvEscape).join(',')];

        for (const row of rows) {
          const fields = [
            ...row.groupColumns.map((gc) => csvEscape(gc.label)),
            csvEscape(String(row.rowTotalHours)),
            ...row.dateHours.map((dh) => csvEscape(String(dh.hours))),
          ];
          csvRows.push(fields.join(','));
        }

        if (grandTotal) {
          const grandTotalFields = [
            ...headers.map((_h, idx) => (idx === 0 ? csvEscape('Grand Total') : csvEscape(''))),
            csvEscape(String(grandTotal.grandTotalHours)),
            ...grandTotal.dateHours.map((dh) => csvEscape(String(dh.hours))),
          ];
          csvRows.push(grandTotalFields.join(','));
        }

        csvData = {
          csvContent: csvRows.join('\n'),
          filename: `worklog-report-${rangeLabel}.csv`,
        };
      }
      downloadCsv(csvData.csvContent, csvData.filename);
    } catch (err) {
      console.error('Failed to export CSV:', err);
      logError({ message: 'Failed to export CSV', stack: String(err) });
      setError(describeReportError(err, 'Failed to export CSV. Please try again.'));
    } finally {
      setCsvExporting(false);
    }
  }, [validate, buildRequest]);

  // ------------------------------------------------------------------
  // Export Comments — one row per worklog, including its comment
  //
  // The pivot export above answers "how many hours, per group, per date".
  // This answers "what did people actually write against those hours", which
  // the report itself can only show one cell at a time in the drill-down
  // popup. Same filters, same date range, same JQL as the report on screen —
  // it re-reads the toolbar via buildRequest() exactly like Export CSV does,
  // so both exports and the report always describe the same query.
  // ------------------------------------------------------------------
  const handleExportComments = useCallback(async () => {
    const errs = validate();
    setValidationErrors(errs);
    if (errs.length > 0) return;

    setError(null);
    setCommentsExporting(true);
    try {
      const req = buildRequest();
      const entries = await fetchAllWorklogEntries(req);

      if (entries.length === 0) {
        throw new Error('No worklog comments to export - no worklogs matched these filters');
      }

      const csvContent = buildCommentsCsv(entries);
      const filename = `worklog-comments-${req.startDate}-to-${req.endDate}.csv`;

      downloadCsv(csvContent, filename);
    } catch (err) {
      console.error('Failed to export worklog comments:', err);
      logError({ message: 'Failed to export worklog comments', stack: String(err) });
      setError(describeReportError(err, 'Failed to export comments. Please try again.'));
    } finally {
      setCommentsExporting(false);
    }
  }, [validate, buildRequest]);

  // ------------------------------------------------------------------
  // Load preset
  // ------------------------------------------------------------------
  const handleLoadPreset = useCallback(
    async (option: SelectOption | null) => {
      setSelectedPreset(option);
      if (!option) return;
      const preset = presets.find((p) => p.name === option.value);
      if (!preset || !filterOptions) return;

      // Fill projects
      const projOpts = preset.projectKeys
        .map((k) => {
          const found = filterOptions.projects.find((p) => p.key === k);
          return found ? { label: `${found.name} (${found.key})`, value: found.key } : null;
        })
        .filter((x): x is SelectOption => x !== null);
      setSelectedProjects(projOpts);

      // Re-scope the Users dropdown to the preset's projects (same cascade
      // as picking projects directly in the toolbar) before resolving the
      // preset's saved user selections, so both the dropdown's available
      // options and the pre-selected users reflect the preset's projects
      // rather than whatever project scope was active before loading it.
      let usersSource = filterOptions.users;
      if (!isAppBuilderPreview) {
        try {
          const newOpts = await invoke<FilterOptions>('getFilterOptions', {
            projectKeys: preset.projectKeys,
          });
          if (newOpts) {
            usersSource = newOpts.users;
            setFilterOptions((prev) => (prev ? { ...prev, users: newOpts.users } : prev));
          }
        } catch (err) {
          console.error('Failed to refresh users for preset:', err);
        }
      }

      // Fill users
      if (preset.userAccountIds && preset.userAccountIds.length > 0) {
        const userOpts = preset.userAccountIds
          .map((id) => {
            const found = usersSource.find((u) => u.accountId === id);
            return found ? { label: found.displayName, value: found.accountId } : null;
          })
          .filter((x): x is SelectOption => x !== null);
        setSelectedUsers(userOpts);
      } else {
        setSelectedUsers([]);
      }

      // Presets saved before JQL existed have no `jql` field — treat those as
      // "no query" so loading an old preset clears any query left in the box
      // rather than silently keeping it and overriding the preset's own
      // Projects/Users selections.
      setJqlFilter(preset.jql ?? '');

      setStartDate(preset.startDate);
      setEndDate(preset.endDate);
      // A preset counts as the user choosing a Period, so it becomes the
      // remembered one too — otherwise loading a preset and reloading the
      // page would silently snap Period back to whatever was stored before.
      const presetPeriod = PERIOD_OPTIONS.find((o) => o.value === preset.period) ?? PERIOD_OPTIONS[1];
      periodTouchedRef.current = true;
      setPeriod(presetPeriod);
      persistPeriod(presetPeriod.value);
      setCategorize(DIMENSION_OPTIONS.find((o) => o.value === preset.categorize) ?? DIMENSION_OPTIONS[0]);
      // Resolved against GROUP_BY_OPTIONS, not DIMENSION_OPTIONS — otherwise a
      // preset saved with Group by = Issues wouldn't match here and would come
      // back silently cleared to None.
      setGroupBy(GROUP_BY_OPTIONS.find((o) => o.value === preset.groupBy) ?? null);
      setSecondGroup(SECOND_GROUP_OPTIONS.find((o) => o.value === (preset.secondGroup ?? '')) ?? SECOND_GROUP_OPTIONS[0]);
      setTimeUnit(TIME_UNIT_OPTIONS.find((o) => o.value === preset.timeUnit) ?? TIME_UNIT_OPTIONS[0]);
      // timeZone is auto-detected — ignore stored value
      // preset.grandTotal is ignored — the report always shows a totals row now.
    },
    [presets, filterOptions, persistPeriod],
  );

  // ------------------------------------------------------------------
  // Save preset
  // ------------------------------------------------------------------
  const handleSavePreset = useCallback(async () => {
    if (!presetName.trim()) return;
    setSavingPreset(true);
    try {
      const preset: FilterPreset = {
        name: presetName.trim(),
        projectKeys: selectedProjects.map((p) => p.value),
        userAccountIds: selectedUsers.map((u) => u.value),
        startDate,
        endDate,
        period: period.value as FilterPreset['period'],
        categorize: categorize?.value,
        groupBy: groupBy?.value,
        secondGroup: secondGroup?.value,
        timeUnit: timeUnit.value as 'decimal' | 'hoursMinutes',
        timeZone: detectTimeZone(),
        jql: jqlFilter.trim() || undefined,
        // Kept in the stored shape for backward compatibility with older
        // presets, but no longer a live toggle — totals are always shown.
        grandTotal: true,
      };

      if (isAppBuilderPreview) {
        setPresets((prev) => [...prev, preset]);
      } else {
        await invoke<SaveFilterResponse>('saveFilterPreset', preset);
        const resp = await invoke<FilterPresetsResponse>('getFilterPresets');
        const updatedPresets = Array.isArray(resp?.presets) ? resp.presets : [];
        setPresets(updatedPresets);
      }
      setIsModalOpen(false);
      setPresetName('');
    } catch (err) {
      console.error('Failed to save preset:', err);
      logError({ message: 'Failed to save filter preset', stack: String(err) });
      setError('Failed to save filter preset. Please try again.');
    } finally {
      setSavingPreset(false);
    }
  }, [presetName, selectedProjects, selectedUsers, startDate, endDate, period, categorize, groupBy, secondGroup, timeUnit, jqlFilter]);

  // ------------------------------------------------------------------
  // Worklog detail drill-down
  // ------------------------------------------------------------------
  const handleCellClick = useCallback(
    async (
      row: WorklogReportResponse['rows'][0],
      dateLabel?: string,
    ) => {
      setDetailError(null);
      setIsDetailModalOpen(true);

      if (isAppBuilderPreview) {
        setDetailLoading(false);
        setDetailEntries([
          {
            issueKey: 'PROJ-10',
            issueSummary: 'Implement feature',
            description: 'Worked on implementation',
            timeSpentHours: 2.5,
            createdDate: '2026-08-01T09:15:00.000+0000',
            bucketKey: dateLabel ?? '',
          },
        ]);
        return;
      }

      // Derive issueKeys from the already-loaded report row data
      const issueKeys = row.issueKeys ?? [];
      // Derive author accountIds if the row is grouped by author
      const authorAccountIds = row.groupColumns
        .filter((gc) => gc.dimension === 'author')
        .map((gc) => {
          // Find accountId from filter options by displayName
          const user = filterOptions?.users.find((u) => u.displayName === gc.label);
          return user?.accountId;
        })
        .filter((id): id is string => !!id);

      // PERFORMANCE: cached by everything EXCEPT dateLabel — every date cell
      // in the same row shares the same issueKeys/authors/range, so the full
      // (unfiltered-by-bucket) result is fetched once per row and reused for
      // every other date cell clicked in that row, instead of re-invoking
      // getWorklogDetails (a full issue + worklog fetch) on every click.
      const cacheKey = [
        [...issueKeys].sort().join(','),
        [...authorAccountIds].sort().join(','),
        reportDateRange.start,
        reportDateRange.end,
        detectTimeZone(),
        reportPeriod,
      ].join('::');

      const cached = detailCacheRef.current.get(cacheKey);
      if (cached) {
        setDetailEntries(dateLabel ? cached.filter((e) => e.bucketKey === dateLabel) : cached);
        setDetailLoading(false);
        return;
      }

      setDetailEntries([]);
      setDetailLoading(true);
      try {
        const payload = {
          issueKeys,
          startDate: reportDateRange.start,
          endDate: reportDateRange.end,
          authorAccountIds: authorAccountIds.length > 0 ? authorAccountIds : undefined,
          timeZone: detectTimeZone(),
          // Must match the period the report was fetched with, since
          // dateLabel is a period-bucket key, not necessarily a single day.
          // dateLabel itself is intentionally omitted — the full range is
          // fetched once (and cached above) rather than once per date cell.
          period: reportPeriod,
        };
        const res = await invoke<WorklogDetailsResponse>('getWorklogDetails', payload);
        const entries = Array.isArray(res?.entries) ? res.entries : [];
        detailCacheRef.current.set(cacheKey, entries);
        setDetailEntries(dateLabel ? entries.filter((e) => e.bucketKey === dateLabel) : entries);
      } catch (err) {
        console.error('Failed to load worklog details:', err);
        logError({ message: 'Failed to load worklog details', stack: String(err) });
        setDetailError('Failed to load worklog details. Please try again.');
      } finally {
        setDetailLoading(false);
      }
    },
    [filterOptions, reportDateRange, reportPeriod],
  );

  // ------------------------------------------------------------------
  // Column sort (Project/Author only) — see the sortColumn state comment.
  // ------------------------------------------------------------------
  const handleSortClick = useCallback((groupColumnIndex: number) => {
    setSortColumn((prev) => {
      if (!prev || prev.index !== groupColumnIndex) return { index: groupColumnIndex, direction: 'asc' };
      return { index: groupColumnIndex, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  /** Which group-column indexes are sortable — Project and Author only, per
   * whatever dimensions are actually active in the current report. */
  const sortableColumnIndexes = useMemo(() => {
    const indexes = new Set<number>();
    if (!report || report.rows.length === 0) return indexes;
    report.rows[0].groupColumns.forEach((gc, idx) => {
      if (gc.dimension === 'project' || gc.dimension === 'author') indexes.add(idx);
    });
    return indexes;
  }, [report]);

  /** report.rows sorted by the active sortColumn, or the resolver's default
   * (hierarchical) order when no column is sorted. Computed once and reused
   * by both buildHead (indicator arrows aren't needed there) and
   * buildAllRows, keeping the two in lockstep automatically since there's
   * only one table now. */
  const sortedReportRows = useMemo(() => {
    if (!report) return [];
    if (!sortColumn) return report.rows;
    const { index, direction } = sortColumn;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const copy = [...report.rows];
    copy.sort((a, b) => {
      const av = a.groupColumns[index]?.label ?? '';
      const bv = b.groupColumns[index]?.label ?? '';
      const cmp = collator.compare(av, bv);
      return direction === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [report, sortColumn]);

  // ------------------------------------------------------------------
  // Build table head & rows
  //
  // A single DynamicTable's worth of head cells (group columns + Total +
  // date columns) — rendered as two separate DynamicTable instances (header
  // and body) so the header can stay frozen while the body scrolls; see
  // tableHorizontalScrollStyle for why. Column sorting is implemented
  // entirely ourselves (sortColumn/handleSortClick) rather than via
  // DynamicTable's isSortable/built-in sort — see the sortColumn state
  // comment for why that built-in behavior can't be used here.
  // ------------------------------------------------------------------
  const buildHead = useCallback(() => {
    if (!report) return { cells: [] };
    // Parallel to groupColumnHeaders (display labels) but gives the actual
    // dimension key per column index, needed to pick the right width style
    // (Project/Issue get wider columns — see bodyStyleForDimension/
    // headerStyleForDimension).
    const groupDimensions = report.rows[0]?.groupColumns.map((gc) => gc.dimension) ?? [];
    const groupCells = report.groupColumnHeaders.map((header, idx) => {
      const isSortableCol = sortableColumnIndexes.has(idx);
      const isActive = sortColumn?.index === idx;
      const arrow = isActive ? (sortColumn!.direction === 'asc' ? ' ▲' : ' ▼') : isSortableCol ? ' ⇅' : '';
      return {
        key: `group-${idx}`,
        content: (
          <Box xcss={headerStyleForDimension(groupDimensions[idx])}>
            {isSortableCol ? (
              <Pressable onClick={() => handleSortClick(idx)} xcss={sortHeaderPressableStyle}>
                <Text weight="bold">{header}{arrow}</Text>
              </Pressable>
            ) : (
              <Text weight="bold">{header}</Text>
            )}
          </Box>
        ),
        shouldTruncate: true,
      };
    });
    const totalCell = {
      key: 'total',
      content: <Box xcss={headerTotalCellStyle}><Text weight="bold">Total</Text></Box>,
      shouldTruncate: true,
    };
    const dateCells = report.rows.length > 0
      ? report.rows[0].dateHours.map((dh, idx) => {
        const [line1, line2] = formatDateHeaderLines(dh.dateLabel, reportPeriod);
        const weekend = isWeekendBucket(dh.dateLabel, reportPeriod);
        return {
          key: `date-${idx}`,
          content: (
            <Box xcss={weekend ? headerCellWeekendStyle : headerCellStyle}>
              <Stack space="space.0" alignInline="center">
                <Text weight="bold">{line1}</Text>
                {line2 && <Text>{line2}</Text>}
              </Stack>
            </Box>
          ),
          shouldTruncate: true,
        };
      })
      : [];
    return { cells: [...groupCells, totalCell, ...dateCells] };
  }, [report, reportPeriod, sortableColumnIndexes, sortColumn, handleSortClick]);

  /** Build the full (unpaginated) set of body row descriptors. */
  const buildAllRows = useCallback(() => {
    if (!report) return [];
    const unit = timeUnit.value;
    const dimCount = report.groupColumnHeaders.length;
    // Parallel to groupColumnHeaders — see the identical comment in buildHead.
    const groupDimensions = report.rows[0]?.groupColumns.map((gc) => gc.dimension) ?? [];
    // Group Total subtotal rows only make sense with 2+ group dimensions
    // (e.g. Project then Author, or Author then Issues) — with a single
    // dimension the "all but the innermost" boundary never changes, so the
    // subtotal would just duplicate the Grand Total row at the very bottom.
    const showGroupTotals = groupTotalEnabled && dimCount >= 2;

    /** Running sum for the group currently being accumulated (all rows that
     * share the same value for every group column except the innermost
     * one) — flushed into a subtotal row whenever that outer value changes
     * (see the loop below). Kept in the same row order as the table so a
     * sortColumn on an outer column still produces one subtotal per
     * contiguous run, consistent with the row-blanking logic just above it. */
    let groupAccum: {
      outerKey: string;
      dateHours: Array<{ dateLabel: string; hours: number }>;
      totalHours: number;
    } | null = null;

    const buildGroupTotalRow = (accum: NonNullable<typeof groupAccum>, key: string) => {
      const cells = report.groupColumnHeaders.map((_h, idx) => ({
        key: `group-${idx}`,
        content: (
          <Box xcss={bodyStyleForDimension(groupDimensions[idx])}>
            {idx === dimCount - 1 ? <Text weight="bold">Total</Text> : <Text>{' '}</Text>}
          </Box>
        ),
      }));
      const totalCell = {
        key: 'total',
        content: (
          <Box xcss={bodyTotalCellStyle}>
            <Text weight="bold">{formatHours(accum.totalHours, unit)}</Text>
          </Box>
        ),
      };
      const dateCells = accum.dateHours.map((dh, idx) => {
        const weekend = isWeekendBucket(dh.dateLabel, reportPeriod);
        return {
          key: `date-${idx}`,
          content: (
            <Box xcss={weekend ? bodyCellWeekendStyle : bodyCellStyle}>
              <Text weight="bold">{formatHours(dh.hours, unit)}</Text>
            </Box>
          ),
        };
      });
      return { key, cells: [...cells, totalCell, ...dateCells] };
    };

    // When grouped by more than one dimension (e.g. Project then User), rows
    // are normally sorted hierarchically, so consecutive rows that share the
    // same value for a group column form one visual "block". Rather than
    // repeating that value on every row in the block, blank it out after its
    // first occurrence — a level only counts as a repeat if every level above
    // it also repeated (otherwise a coincidental same label under a
    // *different* parent would wrongly get merged away). Sorting by a
    // different column (sortColumn) naturally stops producing contiguous
    // blocks for the other levels, so this simply stops blanking anything for
    // them — no special-casing needed.
    let prevGroupLabels: string[] = [];
    type BodyCell = { key: string; content: JSX.Element };
    const dataRows: Array<{ key: string; cells: BodyCell[] }> = [];
    sortedReportRows.forEach((row, rowIdx) => {
      if (showGroupTotals) {
        const outerKey = row.groupColumns.slice(0, dimCount - 1).map((g) => g.label).join('|||');
        if (groupAccum && groupAccum.outerKey !== outerKey) {
          dataRows.push(buildGroupTotalRow(groupAccum, `group-total-${dataRows.length}`));
          groupAccum = null;
        }
        if (!groupAccum) {
          groupAccum = {
            outerKey,
            dateHours: row.dateHours.map((dh) => ({ dateLabel: dh.dateLabel, hours: 0 })),
            totalHours: 0,
          };
        }
        groupAccum.dateHours = groupAccum.dateHours.map((dh, i) => ({
          ...dh,
          hours: Math.round((dh.hours + (row.dateHours[i]?.hours ?? 0)) * 100) / 100,
        }));
        groupAccum.totalHours = Math.round((groupAccum.totalHours + row.rowTotalHours) * 100) / 100;
      }

      const groupCells = row.groupColumns.map((gc, idx) => {
        const parentLevelsMatch = row.groupColumns
          .slice(0, idx)
          .every((g, i) => prevGroupLabels[i] === g.label);
        const isRepeatOfPrevRow = parentLevelsMatch && prevGroupLabels[idx] === gc.label;
        const isIssueDimension = gc.dimension === 'issue' || gc.dimension === 'issues';
        let cellContent: React.ReactNode = isRepeatOfPrevRow ? '' : gc.label;
        if (!isRepeatOfPrevRow && isIssueDimension) {
          const { key: issueKey, display } = formatIssueLabel(gc.label);
          // Relative path — the app runs on the Jira site's own origin, so
          // this opens the real issue in a new tab, same as the Worklog
          // Detail modal's Issue Key link.
          cellContent = issueKey ? (
            <Link href={`/browse/${issueKey}`} openNewTab>
              {display}
            </Link>
          ) : (
            display
          );
        }
        return {
          key: `group-${idx}`,
          content: <Box xcss={bodyStyleForDimension(gc.dimension)}>{cellContent}</Box>,
        };
      });
      prevGroupLabels = row.groupColumns.map((gc) => gc.label);
      const totalCell = {
        key: 'total',
        // Clickable, exactly like the date cells below, but with no dateLabel —
        // handleCellClick then leaves the results unfiltered by bucket, so the
        // popup lists every worklog behind this row across the whole reported
        // range instead of a single period. It reuses the same cached fetch the
        // date cells populate, so opening Total after any date cell in the same
        // row costs nothing.
        //
        // Flagged red (text colour only, no cell/pill background — see the
        // "Cell backgrounds" comment above bodyTotalCellStyle) when any of
        // this row's date cells has a worklog with a blank comment; mirrors
        // the per-date-cell highlighting below.
        content: (
          <Box xcss={bodyTotalCellStyle}>
            {row.rowTotalHours > 0 ? (
              <Pressable
                onClick={() => handleCellClick(row)}
                xcss={row.rowHasEmptyComment ? dateValueMissingCommentStyle : dateValuePressableStyle}
              >
                <Text weight="bold">{formatHours(row.rowTotalHours, unit)}</Text>
              </Pressable>
            ) : (
              <Text weight="bold">{formatHours(row.rowTotalHours, unit)}</Text>
            )}
          </Box>
        ),
      };
      const dateCells = row.dateHours.map((dh, idx) => {
        const weekend = isWeekendBucket(dh.dateLabel, reportPeriod);
        return {
          key: `date-${idx}`,
          // Pressable (not Button) here — Button's chrome/padding renders
          // taller than a plain Text cell, which would make rows an
          // inconsistent height. A blank-comment bucket only recolors the
          // number itself (dateValueMissingCommentStyle) rather than the
          // whole cell background; a weekend column greys the whole cell
          // background to denote an off day.
          content: (
            <Box xcss={weekend ? bodyCellWeekendStyle : bodyCellStyle}>
              {dh.hours > 0 ? (
                <Pressable
                  onClick={() => handleCellClick(row, dh.dateLabel)}
                  xcss={dh.hasEmptyComment ? dateValueMissingCommentStyle : dateValuePressableStyle}
                >
                  <Text>{formatHours(dh.hours, unit)}</Text>
                </Pressable>
              ) : (
                <Text>-</Text>
              )}
            </Box>
          ),
        };
      });
      dataRows.push({
        key: `row-${rowIdx}`,
        cells: [...groupCells, totalCell, ...dateCells],
      });
    });

    // Flush the last accumulated group (its boundary is the end of the data,
    // not a label change, so the loop above never sees it).
    if (showGroupTotals && groupAccum) {
      dataRows.push(buildGroupTotalRow(groupAccum, `group-total-${dataRows.length}`));
    }

    // Grand Total row — always shown at the bottom of the report when
    // there's data. Not frozen as a footer (out of scope) — it's simply the
    // body's last row and scrolls with the rest of the body.
    if (report.grandTotal) {
      const gt = report.grandTotal;
      const emptyGroupCells = report.groupColumnHeaders.map((_h, idx) => ({
        key: `group-${idx}`,
        content: (
          <Box xcss={bodyStyleForDimension(groupDimensions[idx])}>
            {idx === 0 ? <Text weight="bold">Total</Text> : <Text>{' '}</Text>}
          </Box>
        ),
      }));
      const gtTotalCell = {
        key: 'total',
        content: (
          <Box xcss={bodyTotalCellStyle}>
            <Text weight="bold">{formatHours(gt.grandTotalHours, unit)}</Text>
          </Box>
        ),
      };
      const gtDateCells = gt.dateHours.map((dh, idx) => {
        const weekend = isWeekendBucket(dh.dateLabel, reportPeriod);
        return {
          key: `date-${idx}`,
          content: (
            <Box xcss={weekend ? bodyCellWeekendStyle : bodyCellStyle}>
              <Text weight="bold">{formatHours(dh.hours, unit)}</Text>
            </Box>
          ),
        };
      });
      dataRows.push({
        key: 'grand-total',
        cells: [...emptyGroupCells, gtTotalCell, ...gtDateCells],
      });
    }

    return dataRows;
  }, [report, sortedReportRows, timeUnit, handleCellClick, reportPeriod, groupTotalEnabled]);

  // ------------------------------------------------------------------
  // Option arrays for selects
  // ------------------------------------------------------------------
  const projectOptions: SelectOption[] = filterOptions
    ? filterOptions.projects.map((p) => ({ label: `${p.name} (${p.key})`, value: p.key }))
    : [];

  const userOptions: SelectOption[] = filterOptions
    ? filterOptions.users.map((u) => ({ label: u.displayName, value: u.accountId }))
    : [];

  const presetOptions: SelectOption[] = presets.map((p) => ({ label: p.name, value: p.name }));

  // ------------------------------------------------------------------
  // Loading state
  // ------------------------------------------------------------------
  if (initLoading) {
    return (
      <Box xcss={containerStyle}>
        <Stack space="space.200" alignInline="center">
          <Spinner size="large" label="Loading..." />
          <Text>Loading worklog report...</Text>
        </Stack>
      </Box>
    );
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <Box xcss={containerStyle}>
      <Stack space="space.300">
        {/* Validation errors */}
        {validationErrors.length > 0 && (
          <SectionMessage appearance="warning" title="Validation">
            <Stack space="space.050">
              {validationErrors.map((msg, i) => (
                <Text key={i}>{msg}</Text>
              ))}
            </Stack>
          </SectionMessage>
        )}

        {/* Error */}
        {error && (
          <SectionMessage appearance="error" title="Error">
            <Text>{error}</Text>
          </SectionMessage>
        )}

        {/* Toolbar — kept to a single row (scrolls horizontally instead of
            wrapping to a second line) so the report below gets the rest of
            the vertical space. */}
        <Box xcss={toolbarStyle}>
          <Box xcss={toolbarScrollStyle}>
            <Inline space="space.100" alignBlock="end" shouldWrap={false}>
              {/* Saved Filters */}
              <Box xcss={fieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="saved-filters">Saved Filters</Label>
                  <Select
                    id="saved-filters"
                    options={presetOptions}
                    value={selectedPreset}
                    onChange={(val: unknown) => handleLoadPreset(val as SelectOption | null)}
                    placeholder="Load preset..."
                    isClearable
                    isSearchable
                  />
                </Stack>
              </Box>

              {/* Save Filter Button */}
              <Box>
                <Stack space="space.050">
                  <Text>&nbsp;</Text>
                  <Button appearance="subtle" onClick={() => setIsModalOpen(true)}>
                    Save Filter
                  </Button>
                </Stack>
              </Box>

              {/* JQL — overrides Projects/Users when non-blank. Given its own
                  wider field since real queries are much longer than a
                  dropdown label. */}
              <Box xcss={jqlFieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="jql-filter">JQL {isJqlActive ? '(overrides filters)' : ''}</Label>
                  <Textfield
                    id="jql-filter"
                    placeholder='e.g. project = ABC AND labels = urgent'
                    value={jqlFilter}
                    onChange={(e) => setJqlFilter(String(e.target.value ?? ''))}
                  />
                </Stack>
              </Box>

              {/* Projects — disabled while a JQL query is active, since the
                  JQL takes precedence and a still-active-looking dropdown
                  would misrepresent what the report covers. */}
              <Box xcss={fieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="projects">Projects</Label>
                  <Select
                    id="projects"
                    isDisabled={isJqlActive}
                    options={projectOptions}
                    value={selectedProjects}
                    onChange={async (val: unknown) => {
                      const opts = Array.isArray(val) ? (val as SelectOption[]) : [];
                      setSelectedProjects(opts);
                      // Cascade: re-fetch users scoped to selected projects
                      if (!isAppBuilderPreview) {
                        try {
                          const projectKeys = opts.map((o) => o.value);
                          const newOpts = await invoke<FilterOptions>('getFilterOptions', { projectKeys });
                          if (newOpts) {
                            setFilterOptions((prev) => prev ? { ...prev, users: newOpts.users } : prev);
                            // Remove any selected users no longer in the refreshed list
                            const validIds = new Set(newOpts.users.map((u) => u.accountId));
                            setSelectedUsers((prev) => prev.filter((u) => validIds.has(u.value)));
                          }
                        } catch (err) {
                          console.error('Failed to refresh users:', err);
                        }
                      }
                    }}
                    placeholder="All projects"
                    isMulti
                    isSearchable
                    isClearable
                  />
                </Stack>
              </Box>

              {/* Users — disabled while a JQL query is active (see Projects). */}
              <Box xcss={fieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="users">Users</Label>
                  <Select
                    id="users"
                    isDisabled={isJqlActive}
                    options={userOptions}
                    value={selectedUsers}
                    onChange={(val: unknown) => {
                      const opts = val as SelectOption[] | null;
                      setSelectedUsers(Array.isArray(opts) ? opts : []);
                    }}
                    placeholder="All users"
                    isMulti
                    isSearchable
                    isClearable
                  />
                </Stack>
              </Box>

              {/* From date */}
              <Box xcss={fieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="from-date">From *</Label>
                  <DatePicker
                    id="from-date"
                    value={startDate}
                    onChange={(val: string) => setStartDate(val)}
                    maxDate={endDate || undefined}
                  />
                </Stack>
              </Box>

              {/* To date — a range spanning several months (e.g. a full
                  year with Period = Month) is fully supported: it's
                  transparently chunked into parallel per-month requests
                  behind the scenes, see fetchChunkedReport. */}
              <Box xcss={fieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="to-date">To *</Label>
                  <DatePicker
                    id="to-date"
                    value={endDate}
                    onChange={(val: string) => setEndDate(val)}
                    minDate={startDate || undefined}
                  />
                </Stack>
              </Box>

              {/* Period — every option ("Day"/"Week"/"Month") is short, so
                  this uses the narrowest field tier. */}
              <Box xcss={compactFieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="period">Period</Label>
                  <Select
                    id="period"
                    options={PERIOD_OPTIONS}
                    value={period}
                    onChange={(val: unknown) => {
                      if (!val) return;
                      const opt = val as SelectOption;
                      periodTouchedRef.current = true;
                      setPeriod(opt);
                      persistPeriod(opt.value);
                    }}
                  />
                </Stack>
              </Box>

              {/* Categorize */}
              <Box xcss={mediumFieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="categorize">Categorize</Label>
                  <Select
                    id="categorize"
                    options={DIMENSION_OPTIONS}
                    value={categorize}
                    onChange={(val: unknown) => setCategorize((val as SelectOption | null) ?? DIMENSION_OPTIONS[0])}
                    placeholder="None"
                    isClearable
                  />
                </Stack>
              </Box>

              {/* Group by */}
              <Box xcss={mediumFieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="group-by">Group by</Label>
                  <Select
                    id="group-by"
                    options={GROUP_BY_OPTIONS}
                    value={groupBy}
                    onChange={(val: unknown) => setGroupBy(val as SelectOption | null)}
                    placeholder="None"
                    isClearable
                  />
                </Stack>
              </Box>

              {/* 2nd Group */}
              <Box xcss={mediumFieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="second-group">2nd Group</Label>
                  <Select
                    id="second-group"
                    options={SECOND_GROUP_OPTIONS}
                    value={secondGroup}
                    onChange={(val: unknown) => {
                      if (val) setSecondGroup(val as SelectOption);
                    }}
                  />
                </Stack>
              </Box>

              {/* Time Unit — "Decimal"/"Hrs:Min" are both short. */}
              <Box xcss={compactFieldStyle}>
                <Stack space="space.050">
                  <Label labelFor="time-unit">Time Unit</Label>
                  <Select
                    id="time-unit"
                    options={TIME_UNIT_OPTIONS}
                    value={timeUnit}
                    onChange={(val: unknown) => {
                      if (val) setTimeUnit(val as SelectOption);
                    }}
                  />
                </Stack>
              </Box>

              {/* Group Total — checked by default; shows a subtotal row per
                  outer group (e.g. per Author, when 2nd Group = Issues). */}
              <Box>
                <Stack space="space.050">
                  <Text>&nbsp;</Text>
                  <Checkbox
                    label="Group Total"
                    isChecked={groupTotalEnabled}
                    onChange={(e) => setGroupTotalEnabled(!!e.target.checked)}
                  />
                </Stack>
              </Box>

              {/* View Report */}
              <Box>
                <Stack space="space.050">
                  <Text>&nbsp;</Text>
                  <Button
                    appearance="primary"
                    onClick={handleViewReport}
                    isDisabled={reportLoading}
                  >
                    View Report
                  </Button>
                </Stack>
              </Box>

              {/* Export CSV */}
              <Box>
                <Stack space="space.050">
                  <Text>&nbsp;</Text>
                  <Button appearance="default" onClick={handleExportCsv} isDisabled={csvExporting}>
                    {csvExporting ? 'Exporting...' : 'Export CSV'}
                  </Button>
                </Stack>
              </Box>

              {/* Export Comments — one row per worklog, with its comment text.
                  Separate from Export CSV rather than extra columns on it,
                  because the two have different shapes: the pivot has one row
                  per group, this has one row per individual worklog. */}
              <Box>
                <Stack space="space.050">
                  <Text>&nbsp;</Text>
                  <Button
                    appearance="default"
                    onClick={handleExportComments}
                    isDisabled={commentsExporting}
                  >
                    {commentsExporting ? 'Exporting...' : 'Export Comments'}
                  </Button>
                </Stack>
              </Box>
            </Inline>
          </Box>
        </Box>

        {/* Report table — no pagination; all rows render in one scrollable
            table (the page itself scrolls for large reports). */}
        <Box xcss={tableContainerStyle}>
          {report ? (
            report.rows.length > 0 ? (
              (() => {
                const bodyRows = buildAllRows();
                // Short reports skip the vertical clip entirely so no
                // scrollbar (real or inert) is drawn — see
                // MAX_UNCLIPPED_BODY_ROWS.
                const clipBody = bodyRows.length > MAX_UNCLIPPED_BODY_ROWS;
                const headerBoxStyle = clipBody
                  ? tableHeaderScrollGutterStyle
                  : tableUnclippedBoxStyle;
                const bodyBoxStyle = clipBody
                  ? tableBodyVerticalScrollStyle
                  : tableUnclippedBoxStyle;

                return (
                  // Frozen header, no isFixedSize (which forces table-layout:
                  // fixed + equal-percentage columns, clipping header text) —
                  // see tableHorizontalScrollStyle for the full technique.
                  // The header table (rows=[]) and the vertical-scroll body
                  // box are both children of this one horizontally-scrolling
                  // outer Box, so they always scroll sideways together.
                  <Box xcss={tableHorizontalScrollStyle}>
                    <Stack space="space.0">
                      {/* Wrapped so the header reserves the same
                          vertical-scrollbar gutter as the body box below and
                          follows the same width rules — otherwise the two
                          tables resolve to different widths and every column
                          boundary skews. See tableHeaderScrollGutterStyle. */}
                      <Box xcss={headerBoxStyle}>
                        <DynamicTable
                          head={buildHead()}
                          rows={[]}
                          label="Worklog report header"
                        />
                      </Box>
                      <Box xcss={bodyBoxStyle}>
                        <DynamicTable
                          // head intentionally omitted (undefined) — this table
                          // is body-only, the header lives in the DynamicTable
                          // above so it can stay outside this vertical scroll box.
                          head={undefined}
                          rows={bodyRows}
                          rowsPerPage={Math.max(bodyRows.length, 1)}
                          isLoading={reportLoading}
                          label="Worklog report"
                        />
                      </Box>
                    </Stack>
                  </Box>
                );
              })()
            ) : (
              <SectionMessage appearance="information" title="No Data">
                <Text>No worklog entries found for the selected filters.</Text>
              </SectionMessage>
            )
          ) : reportLoading ? (
            <Stack space="space.200" alignInline="center">
              <Spinner size="large" label="Loading report..." />
              <Text>
                {loadedCount !== null && loadedCount > 0
                  ? `Loaded ${loadedCount} issues so far...`
                  : 'Generating report...'}
              </Text>
            </Stack>
          ) : (
            <SectionMessage appearance="information" title="Get Started">
              <Text>Select your filters and click &quot;View Report&quot; to generate the worklog report.</Text>
            </SectionMessage>
          )}
        </Box>
      </Stack>

      {/* Save Filter Modal */}
      <ModalTransition>
        {isModalOpen && (
          <Modal onClose={() => setIsModalOpen(false)} width="small">
            <ModalHeader>
              <ModalTitle>Save Filter Preset</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.150">
                <Label labelFor="preset-name">Preset Name</Label>
                <Textfield
                  id="preset-name"
                  placeholder="Enter a name for this filter preset"
                  value={presetName}
                  onChange={(e) => setPresetName(String(e.target.value ?? ''))}
                />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <ButtonGroup>
                <Button appearance="subtle" onClick={() => setIsModalOpen(false)}>
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  onClick={handleSavePreset}
                  isDisabled={!presetName.trim() || savingPreset}
                >
                  {savingPreset ? 'Saving...' : 'Save'}
                </Button>
              </ButtonGroup>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>

      {/* Worklog Detail Modal */}
      <ModalTransition>
        {isDetailModalOpen && (
          <Modal onClose={() => setIsDetailModalOpen(false)} width="x-large">
            <ModalHeader>
              <ModalTitle>Worklog Details</ModalTitle>
            </ModalHeader>
            <ModalBody>
              {detailLoading ? (
                <Stack space="space.200" alignInline="center">
                  <Spinner size="large" label="Loading details..." />
                  <Text>Loading worklog details...</Text>
                </Stack>
              ) : detailError ? (
                <SectionMessage appearance="error" title="Error">
                  <Text>{detailError}</Text>
                </SectionMessage>
              ) : detailEntries.length === 0 ? (
                <SectionMessage appearance="information" title="No Entries">
                  <Text>No worklog entries found.</Text>
                </SectionMessage>
              ) : (
                <Box xcss={detailTableScrollStyle}>
                <DynamicTable
                  head={{
                    cells: [
                      { key: 'issueKey', content: 'Issue Key', isSortable: true },
                      { key: 'summary', content: 'Issue Summary', isSortable: false },
                      { key: 'comment', content: 'Comment', isSortable: false },
                      { key: 'time', content: 'Time', isSortable: true },
                      { key: 'createdDate', content: 'Worklog Created Date', isSortable: false },
                    ],
                  }}
                  rows={detailEntries.map((entry, idx) => ({
                    key: `detail-${idx}`,
                    cells: [
                      {
                        key: 'issueKey',
                        // Relative path — the app runs on the Jira site's own
                        // origin, so this opens the real issue in a new tab.
                        content: (
                          <Link href={`/browse/${entry.issueKey}`} openNewTab>
                            {entry.issueKey}
                          </Link>
                        ),
                      },
                      {
                        key: 'summary',
                        content: entry.issueSummary,
                      },
                      {
                        key: 'comment',
                        content: renderCommentLines(entry.description),
                      },
                      {
                        key: 'time',
                        content: formatHours(entry.timeSpentHours, timeUnit.value),
                      },
                      {
                        key: 'createdDate',
                        // The date/time this worklog was actually *created* in
                        // Jira — not the "started" date the work was logged
                        // against (that's what the report's own date columns
                        // and the row/period filtering above are based on).
                        content: formatCreatedDate(entry.createdDate, detectTimeZone()),
                      },
                    ],
                  }))}
                  // Every entry on one page — the scroll box above replaces
                  // DynamicTable's pager. Math.max guards the 0-row case,
                  // which DynamicTable rejects.
                  rowsPerPage={Math.max(detailEntries.length, 1)}
                  label="Worklog detail entries"
                />
                </Box>
              )}
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setIsDetailModalOpen(false)}>
                Close
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
ForgeReconciler.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

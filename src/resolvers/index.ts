import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import type { APIResponse } from '@forge/api';
import api from '@forge/api';
import kvs from '@forge/kvs';
import type {
  WorklogReportRequest,
  WorklogPivotRow,
  WorklogReportResponse,
  CsvExportResponse,
  FilterOptions,
  FilterOptionsRequest,
  FilterPreset,
  FilterPresetsResponse,
  SaveFilterResponse,
  UserPreferences,
  WorklogExportEntry,
  WorklogEntriesResponse,
  WorklogDetailsRequest,
  WorklogDetailEntry,
  WorklogDetailsResponse,
} from '../types/worklog-types';

// Basic type for Forge resolver request
interface ResolverRequest {
  payload?: unknown;
  context?: {
    accountId?: string;
    cloudId?: string;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Helper: safe JSON response parsing
// ---------------------------------------------------------------------------

async function safeJsonResponse<T>(response: APIResponse): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API request failed with status ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Helper: Fetch all projects with pagination
// ---------------------------------------------------------------------------

async function fetchAllProjects(): Promise<Array<{ key: string; name: string }>> {
  const projects: Array<{ key: string; name: string }> = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const response = await api
      .asUser()
      .requestJira(route`/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`);

    const data = await safeJsonResponse<{
      values: Array<{ key: string; name: string }>;
      isLast: boolean;
    }>(response);

    const values = Array.isArray(data.values) ? data.values : [];
    for (const p of values) {
      projects.push({ key: p.key, name: p.name });
    }

    if (data.isLast || values.length === 0) {
      break;
    }
    startAt += values.length;
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

// ---------------------------------------------------------------------------
// Helper: Fetch all users with pagination
// ---------------------------------------------------------------------------

async function fetchAllUsers(): Promise<Array<{ accountId: string; displayName: string }>> {
  const users: Array<{ accountId: string; displayName: string }> = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const response = await api
      .asUser()
      .requestJira(route`/rest/api/3/users/search?startAt=${startAt}&maxResults=${maxResults}`);

    const data = await safeJsonResponse<
      Array<{ accountId: string; displayName: string; accountType?: string; active?: boolean }>
    >(response);
    const list = Array.isArray(data) ? data : [];

    for (const u of list) {
      // Only include active human (atlassian) accounts — filter out app/bot/customer accounts
      if (u.accountType !== 'atlassian') {
        continue;
      }
      // Exclude inactive users
      if (u.active === false) {
        continue;
      }
      // Exclude users with missing or empty displayName
      if (!u.displayName || !u.displayName.trim()) {
        continue;
      }
      users.push({ accountId: u.accountId, displayName: u.displayName });
    }

    if (list.length < maxResults) {
      break;
    }
    startAt += list.length;
  }

  users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return users;
}

// ---------------------------------------------------------------------------
// Helper: Fetch users scoped to projects (cascading filter)
// ---------------------------------------------------------------------------

async function fetchUsersByProjectKeys(
  projectKeys: string[],
): Promise<Array<{ accountId: string; displayName: string }>> {
  // PERFORMANCE: this used to enumerate every issue in the selected projects
  // (a paginated JQL search) and then fetch EVERY one of those issues' full
  // worklog list just to collect the distinct set of authors — for a project
  // with a few hundred issues that's a few hundred sequential/batched worklog
  // API calls just to populate a dropdown, which is what made both the
  // Projects-cascade and "load preset" flows feel slow. Jira's
  // assignable-user search scopes users to a project directly in 1-2 calls.
  // This is a reasonable proxy for "people who work in this project" (an
  // approximation — assignable rather than strictly has-logged-work-here —
  // acceptable for a filter dropdown, since it doesn't affect the report's
  // actual computed numbers).
  const users: Array<{ accountId: string; displayName: string }> = [];
  const seen = new Set<string>();
  const projectKeysParam = projectKeys.join(',');
  let startAt = 0;
  const maxResults = 50;

  while (true) {
    const response = await api
      .asUser()
      .requestJira(
        route`/rest/api/3/user/assignable/multiProjectSearch?projectKeys=${projectKeysParam}&startAt=${startAt}&maxResults=${maxResults}`,
      );

    const data = await safeJsonResponse<
      Array<{ accountId: string; displayName: string; accountType?: string; active?: boolean }>
    >(response);
    const list = Array.isArray(data) ? data : [];

    for (const u of list) {
      if (!u.accountId || seen.has(u.accountId)) continue;
      if (u.accountType && u.accountType !== 'atlassian') continue;
      if (u.active === false) continue;
      if (!u.displayName || !u.displayName.trim()) continue;
      seen.add(u.accountId);
      users.push({ accountId: u.accountId, displayName: u.displayName });
    }

    if (list.length < maxResults) {
      break;
    }
    startAt += list.length;
  }

  users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return users;
}

// ---------------------------------------------------------------------------
// Helper: Fetch epics
// ---------------------------------------------------------------------------

async function fetchEpics(): Promise<Array<{ key: string; summary: string }>> {
  const epics: Array<{ key: string; summary: string }> = [];
  let nextPageToken: string | undefined;

  while (true) {
    const body: Record<string, unknown> = {
      jql: 'issuetype = Epic ORDER BY key ASC',
      fields: ['summary'],
      maxResults: 100,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await safeJsonResponse<{
      issues: Array<{ key: string; fields: { summary: string } }>;
      nextPageToken?: string;
    }>(response);

    const issues = Array.isArray(data.issues) ? data.issues : [];
    for (const issue of issues) {
      epics.push({ key: issue.key, summary: issue.fields?.summary ?? '' });
    }

    if (!data.nextPageToken || issues.length === 0) {
      break;
    }
    nextPageToken = data.nextPageToken;
  }

  return epics;
}

// ---------------------------------------------------------------------------
// Helper: Fetch distinct issue types from projects
// ---------------------------------------------------------------------------

async function fetchIssueTypes(): Promise<string[]> {
  const issueTypeSet = new Set<string>();

  // Use issue type search to get all available issue types
  const response = await api.asUser().requestJira(route`/rest/api/3/issuetype`);
  const data = await safeJsonResponse<Array<{ name: string }>>(response);
  const types = Array.isArray(data) ? data : [];

  for (const t of types) {
    if (t.name) {
      issueTypeSet.add(t.name);
    }
  }

  return Array.from(issueTypeSet).sort();
}

// ---------------------------------------------------------------------------
// Helper: Build JQL from request params
// ---------------------------------------------------------------------------

/**
 * Marker prefix on issue-search errors that are the query's fault rather than
 * a transport/permission failure. The frontend matches on it to show Jira's
 * own explanation instead of a generic "failed to load" message.
 */
export const JQL_ERROR_PREFIX = 'Invalid search query: ';

/**
 * Removes a trailing `ORDER BY ...` clause from user-supplied JQL.
 *
 * The report always appends its own `ORDER BY key ASC` and wraps the user's
 * JQL in parentheses so it can be AND-ed with the worklogDate bounds. Jira
 * rejects `ORDER BY` inside parentheses (and only allows one, at the very
 * end), so a user pasting a query straight out of Jira's issue search — which
 * almost always ends in `ORDER BY created DESC` or similar — would otherwise
 * get a confusing syntax error. Their sort order is irrelevant here anyway:
 * the report aggregates the matched issues rather than listing them.
 */
export function stripTrailingOrderBy(jql: string): string {
  // Only strips an ORDER BY that isn't inside quotes — a literal "order by"
  // appearing inside a quoted value (e.g. summary ~ "order by date") must be
  // left alone.
  let inSingle = false;
  let inDouble = false;
  let cutAt = -1;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (ch === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '\'' && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble && (ch === 'o' || ch === 'O')) {
      const rest = jql.slice(i);
      if (/^order\s+by\b/i.test(rest)) {
        // Must be at a token boundary (start, or preceded by whitespace/paren).
        const prev = i === 0 ? ' ' : jql[i - 1];
        if (/[\s)]/.test(prev) || i === 0) cutAt = i;
      }
    }
  }
  return (cutAt === -1 ? jql : jql.slice(0, cutAt)).trim();
}

function buildJql(params: WorklogReportRequest): string {
  const clauses: string[] = [];

  // A JQL override replaces every structured issue filter below (project,
  // issue type, status, assignee, epic) — the user is specifying the issue
  // set directly. The worklogDate bounds further down still apply: they
  // define the report's date columns rather than acting as a filter, and
  // without them the report would fan out worklog fetches across every issue
  // the JQL matches for all time.
  const jqlOverride = params.jql?.trim();
  if (jqlOverride) {
    // Parenthesised so a top-level `OR` in the user's JQL can't swallow the
    // AND-ed worklogDate bounds (e.g. `a OR b AND worklogDate >= x` would
    // otherwise parse as `a OR (b AND ...)`, silently widening the range).
    clauses.push(`(${stripTrailingOrderBy(jqlOverride)})`);
  } else {
    // Project filter — omit when empty so search covers all accessible projects
    if (params.projectKeys && params.projectKeys.length > 0) {
      const keys = params.projectKeys.map((k) => `"${k}"`).join(', ');
      clauses.push(`project in (${keys})`);
    }

    // Issue type filter
    if (params.filters?.issueTypes && params.filters.issueTypes.length > 0) {
      const types = params.filters.issueTypes.map((t) => `"${t}"`).join(', ');
      clauses.push(`issuetype in (${types})`);
    }

    // Status filter
    if (params.filters?.statuses && params.filters.statuses.length > 0) {
      const statuses = params.filters.statuses.map((s) => `"${s}"`).join(', ');
      clauses.push(`status in (${statuses})`);
    }

    // Worklog author filter — the toolbar's "Users" control.
    //
    // This MUST be `worklogAuthor`, not `assignee`. In a worklog report
    // "Users" means *who logged the time*, which has nothing to do with who
    // the issue happens to be assigned to. Filtering on `assignee` (as this
    // did previously) silently dropped every hour a selected user logged
    // against somebody else's issue — and for most people that is the bulk of
    // their time. A real example: a five-day report for one user returned 20h
    // instead of 40h, because only 2 of the 8 issues they had logged against
    // were assigned to them; the other 6 issues' worklogs were excluded here,
    // at search time, and never even fetched.
    //
    // Jira evaluates `worklogAuthor` and the `worklogDate` bounds below as
    // independent clauses — an issue matches if it has ANY worklog by these
    // authors AND ANY worklog in the date range, not necessarily the same
    // worklog — so this deliberately over-matches. That is correct and
    // intentional here: this clause only decides which issues get their
    // worklogs fetched, and buildReportData then narrows precisely, per
    // worklog, on both author and date.
    if (params.filters?.authors && params.filters.authors.length > 0) {
      const authors = params.filters.authors.map((a) => `"${a}"`).join(', ');
      clauses.push(`worklogAuthor in (${authors})`);
    }

    // Epic filter (parent)
    if (params.filters?.epics && params.filters.epics.length > 0) {
      const epicKeys = params.filters.epics.map((e) => `"${e}"`).join(', ');
      clauses.push(`parent in (${epicKeys})`);
    }
  }

  // Worklog date filter to narrow down issues. Widened by a day on each
  // side of the requested range: JQL's `worklogDate` is evaluated using the
  // Jira site's own configured timezone, which may not match the calendar
  // date embedded in any given worklog's own `started` offset — without
  // this buffer, an issue whose only in-range worklog sits within 24h of
  // the boundary could be excluded here before the precise in-memory filter
  // (see getWorklogLoggedDate below) ever gets a chance to evaluate it. The
  // buffer only widens which issues get fetched — the exact date range is
  // still enforced precisely afterward.
  clauses.push(`worklogDate >= "${shiftDateString(params.startDate, -1)}"`);
  clauses.push(`worklogDate <= "${shiftDateString(params.endDate, 1)}"`);

  return clauses.join(' AND ') + ' ORDER BY key ASC';
}

// ---------------------------------------------------------------------------
// Helper: The calendar date a worklog is *logged for*.
//
// `worklog.started` is an ISO datetime with a numeric offset, e.g.
// "2026-07-31T22:58:00.000+0000" — that offset is whatever timezone was in
// effect for the person who logged it (typically their Jira profile
// timezone), so the date portion already IS the day they consider the work
// to have been performed on, and the same day Jira's own issue view shows.
//
// This deliberately does NOT re-project the instant into a different
// timezone (e.g. the report viewer's own browser timezone) before reading
// the date. Doing that previously meant a worklog logged late at night
// could get bucketed under the *next* calendar day/week purely because of
// which timezone happened to be viewing the report — with no relation to
// the date the work was actually logged against. Reading the date straight
// off `started` makes the bucketing deterministic and matches what every
// viewer sees on the issue itself, regardless of their own timezone.
// ---------------------------------------------------------------------------

function getWorklogLoggedDate(started: string): string {
  return started.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Helper: Bucket a calendar date (YYYY-MM-DD) into a period column key.
// The key is always the YYYY-MM-DD of the bucket's first day, so downstream
// code can keep treating date labels as plain dates for sorting/formatting.
// ---------------------------------------------------------------------------

function getISOWeekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

function getPeriodBucketKey(dateStr: string, period: WorklogReportRequest['period']): string {
  switch (period) {
    case 'week':
      return getISOWeekStart(dateStr);
    case 'month':
      return `${dateStr.slice(0, 7)}-01`;
    case 'quarter': {
      const [y, m] = dateStr.split('-').map(Number);
      const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      return `${y}-${String(quarterStartMonth).padStart(2, '0')}-01`;
    }
    case 'year':
      return `${dateStr.slice(0, 4)}-01-01`;
    case 'day':
    case 'custom':
    default:
      return dateStr;
  }
}

// ---------------------------------------------------------------------------
// Helper: Generate the ordered, de-duplicated period-bucket labels spanning a
// date range (e.g. one label per day, per ISO week, per month, etc.)
// ---------------------------------------------------------------------------

function generateDateLabels(startDate: string, endDate: string, period: WorklogReportRequest['period']): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (current <= end) {
    const dayStr = current.toISOString().slice(0, 10);
    const bucket = getPeriodBucketKey(dayStr, period);
    if (!seen.has(bucket)) {
      seen.add(bucket);
      labels.push(bucket);
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return labels;
}

// ---------------------------------------------------------------------------
// Helper: Shift a YYYY-MM-DD date string by a number of calendar days
// (calendar-only math, independent of any timezone).
// ---------------------------------------------------------------------------

function shiftDateString(dateStr: string, deltaDays: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Helper: Search issues with pagination via POST /rest/api/3/search/jql
// ---------------------------------------------------------------------------

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    issuetype?: { name: string };
    status?: { name: string };
    parent?: { key: string; fields?: { summary?: string; issuetype?: { name?: string } } };
    project?: { key: string; name: string };
    assignee?: { accountId: string; displayName: string };
  };
}

interface SearchResult {
  issues: JiraIssue[];
  total: number;
}

/**
 * Search issues with full pagination (fetches ALL pages).
 */
async function searchIssues(jql: string): Promise<JiraIssue[]> {
  const result = await searchIssuesPaginated(jql);
  return result.issues;
}

/**
 * Search one page of issues. Returns the issues, total count, and nextPageToken.
 */
async function searchIssuesPage(
  jql: string,
  pageToken?: string,
  maxResults = 50,
): Promise<{ issues: JiraIssue[]; total: number; nextPageToken: string | null }> {
  const body: Record<string, unknown> = {
    jql,
    fields: ['summary', 'issuetype', 'status', 'parent', 'project', 'assignee'],
    maxResults,
  };
  if (pageToken) {
    body.nextPageToken = pageToken;
  }

  const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // A 400 here almost always means the JQL itself didn't parse or references
  // an unknown field/value. Jira's response carries a precise reason, which is
  // far more actionable than a generic failure — surface it verbatim so the
  // frontend can show the user exactly what's wrong with their query.
  if (response.status === 400) {
    const raw = await response.text().catch(() => '');
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { errorMessages?: string[]; errors?: Record<string, string> };
      const messages = [
        ...(Array.isArray(parsed.errorMessages) ? parsed.errorMessages : []),
        ...(parsed.errors ? Object.values(parsed.errors) : []),
      ].filter((m) => typeof m === 'string' && m.trim());
      if (messages.length > 0) detail = messages.join(' ');
    } catch {
      // Non-JSON body — fall back to the raw text.
    }
    throw new Error(`${JQL_ERROR_PREFIX}${detail || 'The query could not be parsed.'}`);
  }

  const data = await safeJsonResponse<{
    issues: JiraIssue[];
    total?: number;
    nextPageToken?: string;
  }>(response);

  const issues = Array.isArray(data.issues) ? data.issues : [];
  const total = typeof data.total === 'number' ? data.total : issues.length;

  return {
    issues,
    total,
    nextPageToken: data.nextPageToken && issues.length > 0 ? data.nextPageToken : null,
  };
}

/**
 * Search issues with full pagination (fetches ALL pages). Returns issues + total.
 */
async function searchIssuesPaginated(jql: string): Promise<SearchResult> {
  const allIssues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let total = 0;

  while (true) {
    const page = await searchIssuesPage(jql, nextPageToken, 100);
    allIssues.push(...page.issues);
    total = page.total;

    if (!page.nextPageToken) {
      break;
    }
    nextPageToken = page.nextPageToken;
  }

  return { issues: allIssues, total };
}

// ---------------------------------------------------------------------------
// Helper: Fetch worklogs for a single issue
// ---------------------------------------------------------------------------

interface WorklogEntry {
  author: { accountId: string; displayName: string; accountType?: string };
  started: string;
  /** When the worklog was actually created in Jira — distinct from `started`
   * (the date/time the work was logged against). Used for the Worklog Detail
   * popup's "Worklog Created Date" column. */
  created: string;
  timeSpentSeconds: number;
  comment?: unknown; // ADF document or string
}

// ---------------------------------------------------------------------------
// Helper: Check if a worklog author is a real human user (not a bot/app)
// ---------------------------------------------------------------------------

function isHumanAuthor(author: WorklogEntry['author'] | undefined): boolean {
  if (!author) return false;
  // If accountType is present, only allow 'atlassian' (human) accounts
  if (author.accountType && author.accountType !== 'atlassian') {
    return false;
  }
  return true;
}

async function fetchWorklogs(
  issueKey: string,
  startedAfterMs: number,
  startedBeforeMs: number,
): Promise<WorklogEntry[]> {
  try {
    const startedAfter = String(startedAfterMs);
    const startedBefore = String(startedBeforeMs);
    const response = await api
      .asUser()
      .requestJira(
        route`/rest/api/3/issue/${issueKey}/worklog?startedAfter=${startedAfter}&startedBefore=${startedBefore}`,
      );

    if (response.status === 404) {
      console.warn(`Issue ${issueKey} not found (404), skipping worklogs`);
      return [];
    }

    const data = await safeJsonResponse<{
      worklogs: Array<{
        author: { accountId: string; displayName: string; accountType?: string };
        started: string;
        created: string;
        timeSpentSeconds: number;
        comment?: unknown;
      }>;
    }>(response);

    return Array.isArray(data.worklogs) ? data.worklogs : [];
  } catch (err) {
    console.warn(`Failed to fetch worklogs for ${issueKey}:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helper: Get dimension label from a worklog + its issue
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: Batch-resolve user accountIds to displayNames via Jira API
// ---------------------------------------------------------------------------

async function resolveUserDisplayNames(
  accountIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  const uniqueIds = [...new Set(accountIds)];

  const batchSize = 10;
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (accountId) => {
        try {
          const response = await api
            .asUser()
            .requestJira(route`/rest/api/3/user?accountId=${accountId}`);
          if (!response.ok) return { accountId, displayName: '' };
          const data = await response.json() as { displayName?: string };
          return { accountId, displayName: data.displayName ?? '' };
        } catch {
          return { accountId, displayName: '' };
        }
      }),
    );
    for (const r of results) {
      if (r.displayName && r.displayName.trim()) {
        nameMap.set(r.accountId, r.displayName);
      }
    }
  }

  return nameMap;
}

function getDimensionLabel(
  dimension: string,
  worklog: WorklogEntry,
  issue: JiraIssue,
  userNameCache?: Map<string, string>,
): string {
  switch (dimension) {
    case 'author': {
      const accountId = worklog.author?.accountId;
      // First try the cache from bulk lookup
      if (accountId && userNameCache?.has(accountId)) {
        return userNameCache.get(accountId)!;
      }
      // Fall back to worklog-embedded displayName
      return worklog.author?.displayName && worklog.author.displayName.trim()
        ? worklog.author.displayName
        : 'Unknown';
    }
    case 'epic': {
      const parent = issue.fields?.parent;
      if (parent?.fields?.issuetype?.name === 'Epic') {
        return `${parent.key}: ${parent.fields?.summary ?? ''}`;
      }
      if (parent) {
        return `${parent.key}: ${parent.fields?.summary ?? ''}`;
      }
      return 'No Epic';
    }
    case 'issueType':
      return issue.fields?.issuetype?.name ?? 'Unknown';
    case 'status':
      return issue.fields?.status?.name ?? 'Unknown';
    case 'project':
      return issue.fields?.project
        ? `${issue.fields.project.key}: ${issue.fields.project.name}`
        : 'Unknown';
    // The frontend's 2nd-Group dropdown sends the dimension key 'issues'
    // (plural — see SECOND_GROUP_OPTIONS in src/frontend/index.tsx). Both
    // spellings are accepted here so grouping doesn't silently fall through
    // to the 'Unknown' default below for every row.
    case 'issue':
    case 'issues':
      return `${issue.key}: ${issue.fields?.summary ?? ''}`;
    default:
      return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Helper: Build worklog report data (shared between report and CSV export)
// ---------------------------------------------------------------------------

interface WorklogWithIssue {
  worklog: WorklogEntry;
  issue: JiraIssue;
}

interface WorklogPageResult {
  /** Worklogs on this page of issues, already narrowed to exactly the set the
   * report counts: inside the date range, authored by a human, and matching
   * the Users filter. */
  worklogs: WorklogWithIssue[];
  loadedIssues: number;
  totalIssues: number;
  nextPageToken: string | null;
}

/**
 * Fetch and filter one page of the report's worklogs.
 *
 * This is the whole "which worklogs does this report cover" question in one
 * place, deliberately shared by buildReportData (which pivots the result into
 * date buckets) and getWorklogEntriesPage (which returns them flat, with
 * comments, for export). Both MUST select identically — an export whose rows
 * don't add up to the report the user is looking at is worse than no export —
 * so the selection lives here rather than being written twice.
 *
 * Returns one page of issues' worth of worklogs; callers page via
 * params.pageToken until nextPageToken is null.
 */
async function fetchWorklogPage(params: WorklogReportRequest): Promise<WorklogPageResult> {
  const jql = buildJql(params);
  const BATCH_SIZE = 50;

  // Fetch one page of issues (or first page if no pageToken)
  const page = await searchIssuesPage(jql, params.pageToken, BATCH_SIZE);
  const issues = page.issues;

  // Fetch window is deliberately widened by a full day on each side and uses
  // plain UTC boundaries — worklog inclusion/bucketing is now based purely
  // on the calendar date embedded in each worklog's own `started` offset
  // (see getWorklogLoggedDate), not the report's timezone, so this window
  // only needs to be wide enough to never miss a worklog whose *own*
  // offset (which can differ from the report's timezone, and from every
  // other worklog's) could place its raw date inside [startDate, endDate].
  // A worklog's UTC instant can be at most ~14h (the largest real-world UTC
  // offset) away from its own local midnight in either direction, so a
  // 1-day buffer on each side comfortably covers any offset. The precise
  // getWorklogLoggedDate-based filter below does the exact narrowing
  // afterward — over-fetching here is harmless, under-fetching would
  // silently and irrecoverably drop worklogs (as it did for two real
  // worklogs logged late in the day in UTC, previously excluded by a
  // narrower, timezone-shifted window).
  const startMs = new Date(`${shiftDateString(params.startDate, -1)}T00:00:00Z`).getTime();
  const endMs = new Date(`${shiftDateString(params.endDate, 2)}T00:00:00Z`).getTime();

  // Fetch worklogs in batches of 10
  const allWorklogsWithIssue: WorklogWithIssue[] = [];
  const worklogBatchSize = 10;

  for (let i = 0; i < issues.length; i += worklogBatchSize) {
    const batch = issues.slice(i, i + worklogBatchSize);
    const batchResults = await Promise.all(
      batch.map(async (issue) => {
        const worklogs = await fetchWorklogs(issue.key, startMs, endMs);
        return worklogs.map((w) => ({ worklog: w, issue }));
      }),
    );
    for (const results of batchResults) {
      allWorklogsWithIssue.push(...results);
    }
  }

  // Filter worklogs to ensure started date is within [startDate, endDate] inclusive
  const startDateStr = params.startDate;
  const endDateStr = params.endDate;
  const filteredWorklogs = allWorklogsWithIssue.filter((item) => {
    const startedDate = getWorklogLoggedDate(item.worklog.started);
    return startedDate >= startDateStr && startedDate <= endDateStr;
  });

  // Exclude worklogs authored by bot/app accounts
  const humanWorklogs = filteredWorklogs.filter((item) => isHumanAuthor(item.worklog.author));

  // Filter by author accountIds if specified. Skipped entirely when a JQL
  // override is in play — JQL replaces the structured filters (see buildJql),
  // and the Users filter is enforced here as well as in the JQL, so leaving
  // this on would let a stale Users selection keep narrowing a JQL report.
  const authorFilter = params.jql?.trim() ? undefined : params.filters?.authors;
  const worklogsToProcess =
    authorFilter && authorFilter.length > 0
      ? humanWorklogs.filter((item) => authorFilter.includes(item.worklog.author?.accountId))
      : humanWorklogs;

  return {
    worklogs: worklogsToProcess,
    loadedIssues: issues.length,
    totalIssues: page.total,
    nextPageToken: page.nextPageToken,
  };
}

/**
 * Build report data with optional batched pagination.
 * When pageToken is provided, only one page of issues is fetched.
 * When pageToken is omitted, the first page is fetched.
 */
async function buildReportData(
  params: WorklogReportRequest,
): Promise<WorklogReportResponse> {
  const { worklogs: worklogsToProcess, loadedIssues, totalIssues, nextPageToken } =
    await fetchWorklogPage(params);

  const dateLabels = generateDateLabels(params.startDate, params.endDate, params.period);
  const dimensions = params.groupBy && params.groupBy.length > 0 ? params.groupBy : ['issue'];

  // Resolve user display names if author dimension is active
  let userNameCache: Map<string, string> | undefined;
  if (dimensions.includes('author')) {
    const authorIds = [
      ...new Set(
        worklogsToProcess
          .map((item) => item.worklog.author?.accountId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (authorIds.length > 0) {
      userNameCache = await resolveUserDisplayNames(authorIds);
    }
  }

  // Group worklogs by composite key of all dimensions
  const groupMap = new Map<
    string,
    {
      groupColumns: Array<{ dimension: string; label: string }>;
      dateHoursMap: Map<string, number>;
      issueKeySet: Set<string>;
      /** Bucket keys with at least one worklog whose comment is blank. */
      emptyCommentBuckets: Set<string>;
    }
  >();

  for (const item of worklogsToProcess) {
    const labels = dimensions.map((dim) => ({
      dimension: dim,
      label: getDimensionLabel(dim, item.worklog, item.issue, userNameCache),
    }));
    const groupKey = labels.map((l) => `${l.dimension}::${l.label}`).join('|||');

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        groupColumns: labels,
        dateHoursMap: new Map<string, number>(),
        issueKeySet: new Set<string>(),
        emptyCommentBuckets: new Set<string>(),
      });
    }

    const group = groupMap.get(groupKey)!;
    group.issueKeySet.add(item.issue.key);
    const worklogDate = getWorklogLoggedDate(item.worklog.started);
    const hours = Math.round((item.worklog.timeSpentSeconds / 3600) * 100) / 100;
    const bucketKey = getPeriodBucketKey(worklogDate, params.period);
    group.dateHoursMap.set(bucketKey, (group.dateHoursMap.get(bucketKey) ?? 0) + hours);
    if (!extractWorklogComment(item.worklog.comment).trim()) {
      group.emptyCommentBuckets.add(bucketKey);
    }
  }

  // Build rows
  const rows: WorklogPivotRow[] = [];
  for (const group of groupMap.values()) {
    const dateHours = dateLabels.map((label) => ({
      dateLabel: label,
      hours: Math.round((group.dateHoursMap.get(label) ?? 0) * 100) / 100,
      hasEmptyComment: group.emptyCommentBuckets.has(label),
    }));
    const rowTotalHours = Math.round(dateHours.reduce((sum, d) => sum + d.hours, 0) * 100) / 100;

    rows.push({
      groupColumns: group.groupColumns,
      dateHours,
      rowTotalHours,
      issueKeys: Array.from(group.issueKeySet),
      rowHasEmptyComment: group.emptyCommentBuckets.size > 0,
    });
  }

  // Sort rows by first group column label
  rows.sort((a, b) => {
    for (let i = 0; i < Math.min(a.groupColumns.length, b.groupColumns.length); i++) {
      const cmp = a.groupColumns[i].label.localeCompare(b.groupColumns[i].label);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  // Build group column headers
  const groupColumnHeaders = dimensions.map((dim) => {
    switch (dim) {
      case 'author':
        return 'Author';
      case 'epic':
        return 'Epic';
      case 'issueType':
        return 'Issue Type';
      case 'status':
        return 'Status';
      case 'project':
        return 'Project';
      case 'issue':
      case 'issues':
        return 'Issue';
      default:
        return dim;
    }
  });

  const isComplete = nextPageToken === null;

  // Grand total — only compute when this is the final batch (isComplete)
  // and grandTotal is requested and there are rows.
  // For batched loading the frontend merges rows and the final grand total
  // is recomputed; but the resolver always returns it when complete & requested.
  let grandTotal: WorklogReportResponse['grandTotal'] = null;
  if (params.grandTotal && isComplete && rows.length > 0) {
    const totalDateHoursMap = new Map<string, number>();
    for (const row of rows) {
      for (const dh of row.dateHours) {
        totalDateHoursMap.set(dh.dateLabel, (totalDateHoursMap.get(dh.dateLabel) ?? 0) + dh.hours);
      }
    }
    const grandDateHours = dateLabels.map((label) => ({
      dateLabel: label,
      hours: Math.round((totalDateHoursMap.get(label) ?? 0) * 100) / 100,
    }));
    const grandTotalHours = Math.round(
      grandDateHours.reduce((sum, d) => sum + d.hours, 0) * 100,
    ) / 100;

    grandTotal = { dateHours: grandDateHours, grandTotalHours };
  }

  // loadedIssues is just the issues fetched in this call — the frontend
  // accumulates the running total across pages.
  return {
    groupColumnHeaders,
    rows,
    grandTotal,
    nextPageToken,
    isComplete,
    progress: { loadedIssues, totalIssues },
  };
}

/**
 * Build complete report data (all pages) for export. Loops internally.
 */
async function buildFullReportData(
  params: WorklogReportRequest,
): Promise<WorklogReportResponse> {
  const allRows: WorklogPivotRow[] = [];
  let headers: string[] = [];
  let token: string | undefined;
  let totalIssues = 0;
  let loadedIssues = 0;

  while (true) {
    const batchParams = { ...params, pageToken: token };
    const batch = await buildReportData(batchParams);
    headers = batch.groupColumnHeaders;
    totalIssues = batch.progress.totalIssues;
    loadedIssues += batch.progress.loadedIssues;

    // Merge rows
    for (const row of batch.rows) {
      const groupKey = row.groupColumns.map((gc) => `${gc.dimension}::${gc.label}`).join('|||');
      const existing = allRows.find(
        (r) => r.groupColumns.map((gc) => `${gc.dimension}::${gc.label}`).join('|||') === groupKey,
      );
      if (existing) {
        // Merge dateHours
        for (let i = 0; i < row.dateHours.length; i++) {
          if (i < existing.dateHours.length) {
            existing.dateHours[i].hours = Math.round(
              (existing.dateHours[i].hours + row.dateHours[i].hours) * 100,
            ) / 100;
            existing.dateHours[i].hasEmptyComment =
              existing.dateHours[i].hasEmptyComment || row.dateHours[i].hasEmptyComment;
          }
        }
        existing.rowTotalHours = Math.round(
          existing.dateHours.reduce((sum, d) => sum + d.hours, 0) * 100,
        ) / 100;
        existing.rowHasEmptyComment = existing.rowHasEmptyComment || row.rowHasEmptyComment;
        // Merge issueKeys
        const existingKeys = new Set(existing.issueKeys ?? []);
        for (const k of row.issueKeys ?? []) {
          existingKeys.add(k);
        }
        existing.issueKeys = Array.from(existingKeys);
      } else {
        allRows.push({ ...row });
      }
    }

    if (batch.isComplete || !batch.nextPageToken) {
      break;
    }
    token = batch.nextPageToken;
  }

  // Sort merged rows
  allRows.sort((a, b) => {
    for (let i = 0; i < Math.min(a.groupColumns.length, b.groupColumns.length); i++) {
      const cmp = a.groupColumns[i].label.localeCompare(b.groupColumns[i].label);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  // Compute grand total over merged rows
  let grandTotal: WorklogReportResponse['grandTotal'] = null;
  if (params.grandTotal && allRows.length > 0) {
    const dateLabels = allRows.length > 0 ? allRows[0].dateHours.map((dh) => dh.dateLabel) : [];
    const totalDateHoursMap = new Map<string, number>();
    for (const row of allRows) {
      for (const dh of row.dateHours) {
        totalDateHoursMap.set(dh.dateLabel, (totalDateHoursMap.get(dh.dateLabel) ?? 0) + dh.hours);
      }
    }
    const grandDateHours = dateLabels.map((label) => ({
      dateLabel: label,
      hours: Math.round((totalDateHoursMap.get(label) ?? 0) * 100) / 100,
    }));
    const grandTotalHours = Math.round(
      grandDateHours.reduce((sum, d) => sum + d.hours, 0) * 100,
    ) / 100;
    grandTotal = { dateHours: grandDateHours, grandTotalHours };
  }

  return {
    groupColumnHeaders: headers,
    rows: allRows,
    grandTotal,
    nextPageToken: null,
    isComplete: true,
    progress: { loadedIssues, totalIssues },
  };
}

// ---------------------------------------------------------------------------
// Helper: Convert ADF (Atlassian Document Format) to text, preserving structure
//
// Worklog comments are routinely written as bullet lists in Jira, and the
// report is far less useful if that structure is thrown away. The previous
// implementation flattened the whole tree with `parts.join('')` — it computed
// a list of block-level node types and then returned the same joined string
// whether the node was a block or not, so the branch did nothing at all. Every
// list item ran together with no separator whatsoever: a real comment on
// RAT-141 came out as
//
//   "Clone the MedFlowAI repo.Understand the architecture.Implemented UI for:AuthAgents..."
//
// rather than the six bullets (including two nested ones) the author wrote.
//
// This renderer emits one line per block, marks list items, and indents nested
// lists — so the text mirrors what the author sees on the issue. The output is
// plain text on purpose: it feeds both the Worklog Detail popup and the
// Export Comments CSV, and a CSV cell can only carry text. Embedded newlines
// are safe there because csvEscape quotes any field containing one.
// ---------------------------------------------------------------------------

/** Two spaces per nesting level — deep enough to read, cheap in a CSV cell. */
const ADF_INDENT = '  ';

/** Mirrors Jira's own nesting glyphs: filled, hollow, then square. */
const ADF_BULLETS = ['•', '◦', '▪'];

/**
 * Flatten a block's inline children (text, mentions, emoji, links) to a
 * string. A `hardBreak` becomes a newline, which the block renderer then
 * splits into separate lines.
 */
function adfInlineText(nodes: unknown[]): string {
  let out = '';
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    const attrs = (n.attrs ?? {}) as Record<string, unknown>;

    switch (n.type) {
      case 'text':
        out += typeof n.text === 'string' ? n.text : '';
        break;
      case 'hardBreak':
        out += '\n';
        break;
      case 'mention':
        // attrs.text already includes the leading '@'.
        out += typeof attrs.text === 'string' ? attrs.text : '';
        break;
      case 'emoji':
        out +=
          (typeof attrs.text === 'string' && attrs.text) ||
          (typeof attrs.shortName === 'string' ? attrs.shortName : '');
        break;
      case 'inlineCard':
      case 'blockCard':
        out += typeof attrs.url === 'string' ? attrs.url : '';
        break;
      default:
        // Unknown inline node — recurse so its text isn't silently dropped.
        if (Array.isArray(n.content)) out += adfInlineText(n.content);
    }
  }
  return out;
}

/** Render a list's items, each marked and indented for its depth. */
function adfListLines(
  items: unknown[],
  depth: number,
  marker: (index: number) => string,
): string[] {
  const pad = ADF_INDENT.repeat(depth);
  const lines: string[] = [];
  let index = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== 'listItem') continue;

    const children = Array.isArray(item.content) ? item.content : [];
    const [first, ...rest] = children;
    const mark = marker(index);

    // The item's first block carries the marker. Rendered at depth 0 so it
    // comes back unpadded — this function owns the indentation.
    const firstLines = first ? adfBlockLines(first, 0) : [''];
    firstLines.forEach((line, i) => {
      lines.push(
        i === 0
          ? `${pad}${mark} ${line}`
          : `${pad}${' '.repeat(mark.length + 1)}${line}`,
      );
    });

    // Anything after it (a second paragraph, a nested list) is a continuation
    // of the same item, so it sits one level deeper.
    for (const child of rest) {
      lines.push(...adfBlockLines(child, depth + 1));
    }

    index++;
  }

  return lines;
}

/** Render one block-level ADF node to its lines, indented for `depth`. */
function adfBlockLines(node: unknown, depth: number): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as Record<string, unknown>;
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  const children = Array.isArray(n.content) ? n.content : [];
  const pad = ADF_INDENT.repeat(depth);

  switch (n.type) {
    case 'bulletList': {
      const glyph = ADF_BULLETS[Math.min(depth, ADF_BULLETS.length - 1)];
      return adfListLines(children, depth, () => glyph);
    }

    case 'orderedList': {
      // `order` is the start number when the author didn't begin at 1.
      const start = typeof attrs.order === 'number' ? attrs.order : 1;
      return adfListLines(children, depth, (i) => `${start + i}.`);
    }

    case 'blockquote':
      return adfBlocksLines(children, depth).map((line) => `> ${line}`);

    case 'rule':
      return [`${pad}---`];

    case 'paragraph':
    case 'heading':
    case 'codeBlock':
    default: {
      // A bare listItem can reach here if the ADF is malformed; treating it
      // as a plain block keeps its text rather than dropping it.
      if (children.length > 0 && children.some((c) => isAdfBlock(c))) {
        return adfBlocksLines(children, depth);
      }
      const text = adfInlineText(children);
      if (!text) return [''];
      return text.split('\n').map((line) => pad + line);
    }
  }
}

/** True for nodes that must be rendered as their own line(s). */
function isAdfBlock(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const type = (node as Record<string, unknown>).type;
  return (
    type === 'paragraph' ||
    type === 'heading' ||
    type === 'bulletList' ||
    type === 'orderedList' ||
    type === 'listItem' ||
    type === 'blockquote' ||
    type === 'codeBlock' ||
    type === 'rule'
  );
}

function adfBlocksLines(nodes: unknown[], depth: number): string[] {
  const lines: string[] = [];
  for (const node of nodes) lines.push(...adfBlockLines(node, depth));
  return lines;
}

export function extractWorklogComment(comment: unknown): string {
  if (!comment) return '';
  if (typeof comment === 'string') return comment;
  if (typeof comment !== 'object') return '';

  const doc = comment as Record<string, unknown>;
  const blocks = Array.isArray(doc.content) ? doc.content : [comment];

  return adfBlocksLines(blocks, 0)
    .join('\n')
    // Empty paragraphs are common in ADF and would otherwise leave big gaps;
    // allow at most one blank line between blocks.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Helper: Format ISO date label to "Day dd-Mon" (e.g. "Mon 05-Jan")
// ---------------------------------------------------------------------------

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateHeader(bucketKey: string, period: WorklogReportRequest['period']): string {
  const d = new Date(bucketKey + 'T00:00:00Z');
  switch (period) {
    case 'week': {
      const weekEnd = new Date(d);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      const start = `${String(d.getUTCDate()).padStart(2, '0')}-${SHORT_MONTHS[d.getUTCMonth()]}`;
      const end = `${String(weekEnd.getUTCDate()).padStart(2, '0')}-${SHORT_MONTHS[weekEnd.getUTCMonth()]}`;
      return `${start} to ${end}`;
    }
    case 'month':
      return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case 'quarter':
      return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
    case 'year':
      return `${d.getUTCFullYear()}`;
    case 'day':
    case 'custom':
    default: {
      const dayName = SHORT_DAYS[d.getUTCDay()];
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mon = SHORT_MONTHS[d.getUTCMonth()];
      return `${dayName} ${dd}-${mon}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: CSV-escape a field
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

// ---------------------------------------------------------------------------
// Resolver setup
// ---------------------------------------------------------------------------

const resolver = new Resolver();

// ---------------------------------------------------------------------------
// getFilterOptions resolver
// ---------------------------------------------------------------------------

resolver.define('getFilterOptions', async (req: ResolverRequest): Promise<FilterOptions> => {
  const input = (req.payload ?? {}) as FilterOptionsRequest;
  const projectKeys = Array.isArray(input.projectKeys) ? input.projectKeys : [];

  let projects: Array<{ key: string; name: string }> = [];
  let users: Array<{ accountId: string; displayName: string }> = [];
  let epics: Array<{ key: string; summary: string }> = [];
  let issueTypes: string[] = [];

  // Determine which user-fetch to run based on projectKeys
  const userFetch = projectKeys.length > 0
    ? fetchUsersByProjectKeys(projectKeys)
    : fetchAllUsers();

  const results = await Promise.allSettled([
    fetchAllProjects(),
    userFetch,
    fetchEpics(),
    fetchIssueTypes(),
  ]);

  if (results[0].status === 'fulfilled') {
    projects = results[0].value;
  } else {
    console.warn('Failed to fetch projects:', results[0].reason);
  }

  if (results[1].status === 'fulfilled') {
    users = results[1].value;
  } else {
    console.warn('Failed to fetch users:', results[1].reason);
  }

  if (results[2].status === 'fulfilled') {
    epics = results[2].value;
  } else {
    console.warn('Failed to fetch epics:', results[2].reason);
  }

  if (results[3].status === 'fulfilled') {
    issueTypes = results[3].value;
  } else {
    console.warn('Failed to fetch issue types:', results[3].reason);
  }

  return { projects, users, epics, issueTypes };
});

// ---------------------------------------------------------------------------
// User preferences (sticky toolbar settings)
//
// Stored per user, separately from the named filter presets: these are the
// "where I left off" settings that should just be there next time, without
// anyone having to save or load a preset by name.
// ---------------------------------------------------------------------------

const VALID_PERIODS: ReadonlyArray<WorklogReportRequest['period']> = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
  'custom',
];

function userPrefsKey(accountId: string): string {
  return `user-prefs:${accountId}`;
}

resolver.define(
  'getUserPreferences',
  async (req: ResolverRequest): Promise<UserPreferences> => {
    const accountId = req.context?.accountId;
    if (!accountId) {
      console.error('No accountId in context for getUserPreferences');
      return {};
    }

    const stored = await kvs.get(userPrefsKey(accountId));
    if (!stored || typeof stored !== 'object') {
      return {};
    }

    // Read defensively rather than trusting the stored shape: these values
    // were written by an older build of this same app, and 'quarter'/'year'/
    // 'custom' in particular can still be sitting in a user's storage from
    // before those options were dropped from the Period dropdown.
    const prefs = stored as Record<string, unknown>;
    const period = prefs.period;
    return {
      period: VALID_PERIODS.includes(period as WorklogReportRequest['period'])
        ? (period as WorklogReportRequest['period'])
        : undefined,
    };
  },
);

resolver.define(
  'saveUserPreferences',
  async (req: ResolverRequest): Promise<{ success: boolean }> => {
    const accountId = req.context?.accountId;
    if (!accountId) {
      throw new Error('No accountId in context');
    }

    const payload = (req.payload ?? {}) as UserPreferences;
    if (payload.period !== undefined && !VALID_PERIODS.includes(payload.period)) {
      throw new Error(`Invalid period: ${String(payload.period)}`);
    }

    const key = userPrefsKey(accountId);
    const stored = await kvs.get(key);
    const existing: UserPreferences =
      stored && typeof stored === 'object' ? (stored as UserPreferences) : {};

    // Merged, not replaced, so a caller updating one preference can't wipe
    // the others as more get added here over time.
    await kvs.set(key, { ...existing, ...payload });

    return { success: true };
  },
);

// ---------------------------------------------------------------------------
// getFilterPresets resolver
// ---------------------------------------------------------------------------

resolver.define(
  'getFilterPresets',
  async (req: ResolverRequest): Promise<FilterPresetsResponse> => {
    const accountId = req.context?.accountId;
    if (!accountId) {
      console.error('No accountId in context for getFilterPresets');
      return { presets: [] };
    }

    const storageKey = `filter-presets:${accountId}`;
    const stored = await kvs.get(storageKey);

    if (!stored) {
      return { presets: [] };
    }

    const presets = Array.isArray(stored) ? (stored as FilterPreset[]) : [];
    return { presets };
  },
);

// ---------------------------------------------------------------------------
// saveFilterPreset resolver
// ---------------------------------------------------------------------------

resolver.define(
  'saveFilterPreset',
  async (req: ResolverRequest): Promise<SaveFilterResponse> => {
    const accountId = req.context?.accountId;
    if (!accountId) {
      throw new Error('No accountId in context');
    }

    const payload = req.payload as FilterPreset | undefined;
    if (!payload || !payload.name || !payload.name.trim()) {
      throw new Error('Preset name is required');
    }
    if (payload.projectKeys !== undefined && !Array.isArray(payload.projectKeys)) {
      throw new Error('projectKeys must be an array');
    }
    if (!payload.startDate || !payload.endDate) {
      throw new Error('startDate and endDate are required');
    }
    if (!payload.period) {
      throw new Error('period is required');
    }
    if (!payload.timeUnit) {
      throw new Error('timeUnit is required');
    }
    // timeZone is optional — auto-detected on frontend, falls back to UTC

    const storageKey = `filter-presets:${accountId}`;
    const stored = await kvs.get(storageKey);
    const presets: FilterPreset[] = Array.isArray(stored) ? (stored as FilterPreset[]) : [];

    // Overwrite if same name exists, otherwise append
    const existingIndex = presets.findIndex(
      (p) => p.name.toLowerCase() === payload.name.toLowerCase(),
    );
    if (existingIndex >= 0) {
      presets[existingIndex] = payload;
    } else {
      presets.push(payload);
    }

    await kvs.set(storageKey, presets);

    return { success: true, name: payload.name };
  },
);

// ---------------------------------------------------------------------------
// getWorklogReport resolver
// ---------------------------------------------------------------------------

resolver.define(
  'getWorklogReport',
  async (req: ResolverRequest): Promise<WorklogReportResponse> => {
    const payload = req.payload as WorklogReportRequest | undefined;

    if (!payload) {
      throw new Error('Request payload is required');
    }
    if (!payload.startDate) {
      throw new Error('startDate is required');
    }
    if (!payload.endDate) {
      throw new Error('endDate is required');
    }

    // Ensure projectKeys is always an array (empty = all accessible projects)
    if (!payload.projectKeys || !Array.isArray(payload.projectKeys)) {
      payload.projectKeys = [];
    }

    return buildReportData(payload);
  },
);

// ---------------------------------------------------------------------------
// exportWorklogReport resolver
// ---------------------------------------------------------------------------

resolver.define(
  'exportWorklogReport',
  async (req: ResolverRequest): Promise<CsvExportResponse> => {
    const payload = req.payload as WorklogReportRequest | undefined;

    if (!payload) {
      throw new Error('Request payload is required');
    }
    if (!payload.startDate) {
      throw new Error('startDate is required');
    }
    if (!payload.endDate) {
      throw new Error('endDate is required');
    }

    // Ensure projectKeys is always an array (empty = all accessible projects)
    if (!payload.projectKeys || !Array.isArray(payload.projectKeys)) {
      payload.projectKeys = [];
    }

    const reportData = await buildFullReportData(payload);

    if (reportData.rows.length === 0) {
      throw new Error('No data to export - the report is empty');
    }

    // Build CSV header with "Day dd-Mon" formatted date columns
    const dateLabels = reportData.rows.length > 0
      ? reportData.rows[0].dateHours.map((dh) => dh.dateLabel)
      : [];
    const headerFields = [
      ...reportData.groupColumnHeaders,
      'Total',
      ...dateLabels.map((label) => formatDateHeader(label, payload.period)),
    ];
    const headerLine = headerFields.map(csvEscape).join(',');

    // Build CSV rows
    const csvRows: string[] = [headerLine];

    for (const row of reportData.rows) {
      const fields = [
        ...row.groupColumns.map((gc) => csvEscape(gc.label)),
        csvEscape(String(row.rowTotalHours)),
        ...row.dateHours.map((dh) => csvEscape(String(dh.hours))),
      ];
      csvRows.push(fields.join(','));
    }

    // Grand total row — always include when requested and rows exist
    if (reportData.grandTotal) {
      const grandTotalFields = [
        ...reportData.groupColumnHeaders.map((_, idx) =>
          idx === 0 ? csvEscape('Grand Total') : csvEscape(''),
        ),
        csvEscape(String(reportData.grandTotal.grandTotalHours)),
        ...reportData.grandTotal.dateHours.map((dh) => csvEscape(String(dh.hours))),
      ];
      csvRows.push(grandTotalFields.join(','));
    }

    const csvContent = csvRows.join('\n');
    const filename = `worklog-report-${payload.startDate}-to-${payload.endDate}.csv`;

    return { csvContent, filename };
  },
);

// ---------------------------------------------------------------------------
// getWorklogEntriesPage resolver
//
// The flat, one-row-per-worklog counterpart to getWorklogReport: same filters,
// same date range, same JQL — but instead of pivoting hours into date buckets
// it returns each individual worklog, including its comment. Backs the
// "Export Comments" button, which is the only way to get every worklog's
// comment out of a report at once (the drill-down popup shows them one cell at
// a time).
//
// Paged for the same reason the report is: a single resolver call that walked
// every page itself would blow Forge's 25-second function timeout on any large
// report. The client loops until isComplete — see fetchAllWorklogEntries.
// ---------------------------------------------------------------------------

resolver.define(
  'getWorklogEntriesPage',
  async (req: ResolverRequest): Promise<WorklogEntriesResponse> => {
    const payload = req.payload as WorklogReportRequest | undefined;

    if (!payload) {
      throw new Error('Request payload is required');
    }
    if (!payload.startDate) {
      throw new Error('startDate is required');
    }
    if (!payload.endDate) {
      throw new Error('endDate is required');
    }
    if (!payload.projectKeys || !Array.isArray(payload.projectKeys)) {
      payload.projectKeys = [];
    }

    const { worklogs, loadedIssues, totalIssues, nextPageToken } =
      await fetchWorklogPage(payload);

    // Resolve display names the same way the report's Author column does, so
    // a name in the export always matches the name in the report it came from.
    // Only the authors actually present on this page are looked up.
    const authorIds = [
      ...new Set(
        worklogs.map((item) => item.worklog.author?.accountId).filter((id): id is string => !!id),
      ),
    ];
    const userNameCache =
      authorIds.length > 0 ? await resolveUserDisplayNames(authorIds) : undefined;

    const entries: WorklogExportEntry[] = worklogs.map((item) => {
      const accountId = item.worklog.author?.accountId;
      return {
        issueKey: item.issue.key,
        issueSummary: item.issue.fields?.summary ?? '',
        projectKey: item.issue.fields?.project?.key ?? '',
        issueType: item.issue.fields?.issuetype?.name ?? '',
        authorDisplayName:
          (accountId && userNameCache?.get(accountId)) ||
          item.worklog.author?.displayName ||
          'Unknown',
        loggedDate: getWorklogLoggedDate(item.worklog.started),
        createdDate: item.worklog.created ?? '',
        timeSpentHours: Math.round((item.worklog.timeSpentSeconds / 3600) * 100) / 100,
        comment: extractWorklogComment(item.worklog.comment),
      };
    });

    return {
      entries,
      nextPageToken,
      isComplete: nextPageToken === null,
      progress: { loadedIssues, totalIssues },
    };
  },
);

// ---------------------------------------------------------------------------
// getWorklogDetails resolver
// ---------------------------------------------------------------------------

resolver.define(
  'getWorklogDetails',
  async (req: ResolverRequest): Promise<WorklogDetailsResponse> => {
    const payload = req.payload as WorklogDetailsRequest | undefined;

    if (!payload) {
      throw new Error('Request payload is required');
    }
    if (!payload.issueKeys || !Array.isArray(payload.issueKeys) || payload.issueKeys.length === 0) {
      throw new Error('issueKeys is required and must not be empty');
    }
    if (!payload.startDate) {
      throw new Error('startDate is required');
    }
    if (!payload.endDate) {
      throw new Error('endDate is required');
    }

    // Widened, timezone-independent fetch window — see the matching comment
    // in buildReportData for why (keeps drill-down totals from disagreeing
    // with the report).
    const startMs = new Date(`${shiftDateString(payload.startDate, -1)}T00:00:00Z`).getTime();
    const endMs = new Date(`${shiftDateString(payload.endDate, 2)}T00:00:00Z`).getTime();

    // PERFORMANCE: the issue-metadata search (summary/etc. for the issue keys)
    // and the per-issue worklog fetch are independent — the worklog fetch
    // only needs the issueKey string, which is already in payload.issueKeys —
    // so these used to run sequentially (search first, *then* fetch worklogs
    // only for keys the search resolved) for no reason. Running them
    // concurrently shaves the issue-search's round trip off the total instead
    // of paying for it on top of the worklog-fetch phase.
    const issueJql = `key in (${payload.issueKeys.map((k) => `"${k}"`).join(', ')})`;
    const batchSize = 10;
    const worklogFetchPromise = (async () => {
      const results: Array<{ issueKey: string; worklog: WorklogEntry }> = [];
      for (let i = 0; i < payload.issueKeys.length; i += batchSize) {
        const batch = payload.issueKeys.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async (issueKey) => {
            const worklogs = await fetchWorklogs(issueKey, startMs, endMs);
            return worklogs.map((w) => ({ issueKey, worklog: w }));
          }),
        );
        for (const r of batchResults) results.push(...r);
      }
      return results;
    })();

    const [issues, worklogResults] = await Promise.all([searchIssues(issueJql), worklogFetchPromise]);

    const issueMap = new Map<string, JiraIssue>();
    for (const issue of issues) {
      issueMap.set(issue.key, issue);
    }

    const allWorklogs: Array<{ worklog: WorklogEntry; issue: JiraIssue }> = worklogResults
      .filter((r) => issueMap.has(r.issueKey))
      .map((r) => ({ worklog: r.worklog, issue: issueMap.get(r.issueKey)! }));

    // Filter worklogs to date range
    let filtered = allWorklogs.filter((item) => {
      const startedDate = getWorklogLoggedDate(item.worklog.started);
      return startedDate >= payload.startDate && startedDate <= payload.endDate;
    });

    // Exclude worklogs authored by bot/app accounts
    filtered = filtered.filter((item) => isHumanAuthor(item.worklog.author));

    // Filter by author accountIds if provided
    if (payload.authorAccountIds && payload.authorAccountIds.length > 0) {
      filtered = filtered.filter((item) =>
        payload.authorAccountIds!.includes(item.worklog.author?.accountId),
      );
    }

    // If dateLabel is specified, further filter to that period bucket
    // (dateLabel is the bucket's start day — e.g. a whole week/month when the
    // report's period isn't 'day', not necessarily a single calendar date).
    if (payload.dateLabel) {
      filtered = filtered.filter(
        (item) => getPeriodBucketKey(getWorklogLoggedDate(item.worklog.started), payload.period ?? 'day') === payload.dateLabel,
      );
    }

    // Map to WorklogDetailEntry. bucketKey is always computed (regardless of
    // whether dateLabel was supplied) so the frontend can fetch a row's full
    // date range once and cache it, then re-filter by bucketKey client-side
    // for every other date cell clicked in that same row instead of
    // re-invoking this resolver each time (see handleCellClick).
    const entries: WorklogDetailEntry[] = filtered.map((item) => ({
      issueKey: item.issue.key,
      issueSummary: item.issue.fields?.summary ?? '',
      description: extractWorklogComment(item.worklog.comment),
      timeSpentHours: Math.round((item.worklog.timeSpentSeconds / 3600) * 100) / 100,
      // Worklog *creation* timestamp in Jira — distinct from `started` (the
      // date the work was logged against), which the date-range filtering
      // above is based on. Raw ISO string; the frontend formats it for display.
      createdDate: item.worklog.created ?? '',
      bucketKey: getPeriodBucketKey(getWorklogLoggedDate(item.worklog.started), payload.period ?? 'day'),
    }));

    return { entries };
  },
);

// ---------------------------------------------------------------------------
// Error logging resolver (kept from template)
// ---------------------------------------------------------------------------

resolver.define('logError', (req: ResolverRequest) => {
  const errorData = req.payload as {
    message: string;
    stack?: string;
    source?: string;
    lineno?: number;
    colno?: number;
    timestamp: string;
    userAgent?: string;
    url?: string;
  };

  // Log structured error data to Forge logging platform
  console.error('[Frontend Error]', {
    message: errorData.message,
    stack: errorData.stack,
    source: errorData.source,
    line: errorData.lineno,
    column: errorData.colno,
    timestamp: errorData.timestamp,
    userAgent: errorData.userAgent,
    url: errorData.url,
  });

  return { success: true };
});

// Type assertion to avoid export naming issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = resolver.getDefinitions() as any;

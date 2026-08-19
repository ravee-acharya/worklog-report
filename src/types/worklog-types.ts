export interface WorklogReportRequest {
  projectKeys: string[];
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  period: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
  groupBy?: string[]; // e.g. ['author', 'epic', 'issue']
  /**
   * Raw JQL supplied by the user to select which issues the report covers.
   * When present and non-blank it OVERRIDES `projectKeys` and every entry in
   * `filters` (see buildJql). The date range still applies — it defines the
   * report's date columns rather than acting as an issue filter — and any
   * trailing `ORDER BY` is stripped so the clause can be safely combined.
   */
  jql?: string;
  filters?: {
    issueTypes?: string[];
    statuses?: string[];
    authors?: string[]; // accountIds
    epics?: string[]; // issue keys
  };
  timeUnit?: 'decimal' | 'hoursMinutes';
  timeZone?: string;
  grandTotal?: boolean;
  pageToken?: string; // opaque cursor for batched loading
}

export interface WorklogPivotRow {
  groupColumns: Array<{ dimension: string; label: string }>;
  dateHours: Array<{
    dateLabel: string;
    hours: number;
    /** True if any worklog contributing to this bucket has a blank comment. */
    hasEmptyComment?: boolean;
  }>;
  rowTotalHours: number;
  /** Issue keys contributing to this row — used by frontend for drill-down */
  issueKeys?: string[];
  /** True if any date bucket in this row has hasEmptyComment — flags the Total cell too. */
  rowHasEmptyComment?: boolean;
}

export interface WorklogReportResponse {
  groupColumnHeaders: string[];
  rows: WorklogPivotRow[];
  grandTotal: {
    dateHours: Array<{ dateLabel: string; hours: number }>;
    grandTotalHours: number;
  } | null;
  nextPageToken: string | null;
  isComplete: boolean;
  progress: { loadedIssues: number; totalIssues: number };
}

export interface CsvExportResponse {
  csvContent: string;
  filename: string;
}

export interface FilterOptionsRequest {
  projectKeys?: string[];
}

export interface FilterOptions {
  projects: Array<{ key: string; name: string }>;
  users: Array<{ accountId: string; displayName: string }>;
  epics: Array<{ key: string; summary: string }>;
  issueTypes: string[];
}

export interface FilterPreset {
  name: string;
  projectKeys: string[];
  userAccountIds?: string[];
  startDate: string;
  endDate: string;
  period: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
  categorize?: string;
  groupBy?: string;
  secondGroup?: string;
  timeUnit: 'decimal' | 'hoursMinutes';
  timeZone: string;
  grandTotal: boolean;
  /** Saved JQL override — see WorklogReportRequest.jql. */
  jql?: string;
  filters?: {
    issueTypes?: string[];
    statuses?: string[];
    authors?: string[];
    epics?: string[];
  };
}

export interface FilterPresetsResponse {
  presets: FilterPreset[];
}

/**
 * Per-user toolbar settings that persist across sessions, independently of
 * the named filter presets. Every field is optional: an absent field means
 * "this user has no stored choice, use the app default", which is also what a
 * brand-new user gets.
 */
export interface UserPreferences {
  /** Last Period the user picked, restored on their next visit. */
  period?: WorklogReportRequest['period'];
}

export interface SaveFilterResponse {
  success: boolean;
  name: string;
}

/**
 * One individual worklog, flattened for export — the "comments per worklog"
 * view of a report, as opposed to WorklogPivotRow's hours-per-date-bucket
 * aggregation. One of these per worklog entry that the report counts, so the
 * timeSpentHours across all of them add up to the report's grand total.
 */
export interface WorklogExportEntry {
  issueKey: string;
  issueSummary: string;
  projectKey: string;
  issueType: string;
  authorDisplayName: string;
  /** YYYY-MM-DD the work was logged against (the report's bucketing date). */
  loggedDate: string;
  /** ISO timestamp of when the worklog was created in Jira — distinct from
   * loggedDate, which is the day the work is attributed to. */
  createdDate: string;
  timeSpentHours: number;
  /** The worklog comment, flattened from ADF to plain text. Often blank. */
  comment: string;
}

/** One page of WorklogExportEntry rows; paged by the client exactly like
 * WorklogReportResponse, to keep each resolver invocation inside Forge's
 * 25-second function timeout. */
export interface WorklogEntriesResponse {
  entries: WorklogExportEntry[];
  nextPageToken: string | null;
  isComplete: boolean;
  progress: { loadedIssues: number; totalIssues: number };
}

export interface WorklogDetailsRequest {
  issueKeys: string[];
  dateLabel?: string;
  startDate: string;
  endDate: string;
  authorAccountIds?: string[];
  timeZone?: string;
  /** Must match the report's period so dateLabel is bucketed the same way. */
  period?: WorklogReportRequest['period'];
}

export interface WorklogDetailEntry {
  issueKey: string;
  issueSummary: string;
  description: string;
  timeSpentHours: number;
  /** ISO timestamp — when the worklog was actually created in Jira (distinct
   * from the "started" date it was logged against). */
  createdDate: string;
  /** The period-bucket key (matches a report dateLabel) this entry's worked
   * date falls into. Lets the frontend cache one full-range fetch per row and
   * re-filter it client-side for every date cell in that row, instead of
   * re-fetching per cell. */
  bucketKey: string;
}

export interface WorklogDetailsResponse {
  entries: WorklogDetailEntry[];
}

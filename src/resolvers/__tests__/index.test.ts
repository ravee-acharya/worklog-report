import { createTestHarness } from '@forge/testing-framework';
import { handler, stripTrailingOrderBy } from '../index';
import type {
  FilterOptions,
  FilterPresetsResponse,
  SaveFilterResponse,
  UserPreferences,
  WorklogEntriesResponse,
  WorklogReportResponse,
  CsvExportResponse,
} from '../../types/worklog-types';

const harness = createTestHarness({
  manifest: './manifest.yml',
  handlers: { resolver: handler },
});

beforeEach(() => harness.reset());

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function addProjectFixture(
  projects: Array<{ key: string; name: string }> = [
    { key: 'PROJ', name: 'Project Alpha' },
    { key: 'BETA', name: 'Beta Project' },
  ],
) {
  harness.addFixture('GET', '/rest/api/3/project/search', {
    status: 200,
    body: {
      values: projects,
      isLast: true,
      startAt: 0,
      maxResults: 100,
    },
  });
}

function addUserFixture(
  users: Array<{ accountId: string; displayName: string; accountType?: string; active?: boolean }> = [
    { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
    { accountId: 'user2', displayName: 'Bob Jones', accountType: 'atlassian' },
  ],
) {
  harness.addFixture('GET', '/rest/api/3/users/search', {
    status: 200,
    body: users,
  });
}

function addEpicFixture(
  issues: Array<{
    key: string;
    fields: { summary: string; issuetype?: { name: string }; status?: { name: string }; project?: { key: string; name: string }; parent?: null; assignee?: null };
  }> = [
    {
      key: 'PROJ-1',
      fields: {
        summary: 'Epic 1',
        issuetype: { name: 'Epic' },
        status: { name: 'Open' },
        project: { key: 'PROJ', name: 'Project Alpha' },
        parent: null,
        assignee: null,
      },
    },
  ],
) {
  // POST /rest/api/3/search/jql is used for both epic search and issue search.
  // The harness matches on method + path prefix, so a single POST fixture is used.
  harness.addFixture('POST', '/rest/api/3/search/jql', {
    status: 200,
    body: { issues },
  });
}

function addIssueTypeFixture(types: Array<{ name: string }> = [{ name: 'Bug' }, { name: 'Story' }, { name: 'Task' }]) {
  harness.addFixture('GET', '/rest/api/3/issuetype', {
    status: 200,
    body: types,
  });
}

function addWorklogFixture(
  issueKey: string,
  worklogs: Array<{
    id: string;
    author: { accountId: string; displayName: string; accountType?: string };
    started: string;
    timeSpentSeconds: number;
  }> = [],
) {
  harness.addFixture('GET', `/rest/api/3/issue/${issueKey}/worklog`, {
    status: 200,
    body: {
      worklogs,
      total: worklogs.length,
      maxResults: 1048576,
      startAt: 0,
    },
  });
}

/** A valid preset payload that passes all saveFilterPreset validations. */
function validPresetPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'My Preset',
    projectKeys: ['PROJ'],
    startDate: '2025-01-01',
    endDate: '2025-01-31',
    period: 'month' as const,
    timeUnit: 'decimal' as const,
    timeZone: 'UTC',
    grandTotal: false,
    ...overrides,
  };
}

/** A valid worklog report request payload. */
function validReportPayload(overrides: Record<string, unknown> = {}) {
  return {
    projectKeys: ['PROJ'],
    startDate: '2025-01-15',
    endDate: '2025-01-15',
    period: 'day' as const,
    groupBy: ['issue'],
    grandTotal: false,
    ...overrides,
  };
}

// ===========================================================================
// getFilterOptions
// ===========================================================================

describe('getFilterOptions', () => {
  it('returns projects sorted alphabetically by name', async () => {
    addProjectFixture([
      { key: 'PROJ', name: 'Project Alpha' },
      { key: 'BETA', name: 'Beta Project' },
    ]);
    addUserFixture([]);
    addEpicFixture([]);
    addIssueTypeFixture([]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.projects).toHaveLength(2);
    // Beta Project < Project Alpha alphabetically
    expect(result.data.projects[0].name).toBe('Beta Project');
    expect(result.data.projects[1].name).toBe('Project Alpha');
  });

  it('returns users sorted alphabetically by displayName', async () => {
    addProjectFixture([]);
    addUserFixture([
      { accountId: 'user2', displayName: 'Bob Jones', accountType: 'atlassian' },
      { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
    ]);
    addEpicFixture([]);
    addIssueTypeFixture([]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.users).toHaveLength(2);
    expect(result.data.users[0].displayName).toBe('Alice Smith');
    expect(result.data.users[1].displayName).toBe('Bob Jones');
  });

  it('returns epics and issue types', async () => {
    addProjectFixture([]);
    addUserFixture([]);
    addEpicFixture([
      {
        key: 'PROJ-1',
        fields: {
          summary: 'Epic 1',
          issuetype: { name: 'Epic' },
          status: { name: 'Open' },
          project: { key: 'PROJ', name: 'Project Alpha' },
          parent: null,
          assignee: null,
        },
      },
    ]);
    addIssueTypeFixture([{ name: 'Task' }, { name: 'Bug' }]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.epics).toEqual([{ key: 'PROJ-1', summary: 'Epic 1' }]);
    // Issue types are sorted alphabetically
    expect(result.data.issueTypes).toEqual(['Bug', 'Task']);
  });

  it('handles empty API responses gracefully', async () => {
    addProjectFixture([]);
    addUserFixture([]);
    addEpicFixture([]);
    addIssueTypeFixture([]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.projects).toEqual([]);
    expect(result.data.users).toEqual([]);
    expect(result.data.epics).toEqual([]);
    expect(result.data.issueTypes).toEqual([]);
  });

  it('excludes bot/app accounts from user list', async () => {
    addProjectFixture([]);
    addUserFixture([
      { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
      { accountId: 'bot1', displayName: 'Jira Bot', accountType: 'app' },
      { accountId: 'user2', displayName: 'Bob Jones', accountType: 'atlassian' },
      { accountId: 'customer1', displayName: 'Customer User', accountType: 'customer' },
    ]);
    addEpicFixture([]);
    addIssueTypeFixture([]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.users).toHaveLength(2);
    expect(result.data.users[0].displayName).toBe('Alice Smith');
    expect(result.data.users[1].displayName).toBe('Bob Jones');
  });

  it('excludes users with missing or empty displayName', async () => {
    addProjectFixture([]);
    addUserFixture([
      { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
      { accountId: 'user2', displayName: '', accountType: 'atlassian' },
      { accountId: 'user3', displayName: '   ', accountType: 'atlassian' },
    ]);
    addEpicFixture([]);
    addIssueTypeFixture([]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.users).toHaveLength(1);
    expect(result.data.users[0].displayName).toBe('Alice Smith');
  });

  it('excludes inactive users from user list', async () => {
    addProjectFixture([]);
    addUserFixture([
      { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian', active: true },
      { accountId: 'user2', displayName: 'Deactivated User', accountType: 'atlassian', active: false },
      { accountId: 'user3', displayName: 'Bob Jones', accountType: 'atlassian' },
    ]);
    addEpicFixture([]);
    addIssueTypeFixture([]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.users).toHaveLength(2);
    expect(result.data.users[0].displayName).toBe('Alice Smith');
    expect(result.data.users[1].displayName).toBe('Bob Jones');
  });

  it('excludes users with undefined accountType', async () => {
    addProjectFixture([]);
    addUserFixture([
      { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
      { accountId: 'unknown1', displayName: 'Mystery User' },
    ]);
    addEpicFixture([]);
    addIssueTypeFixture([]);

    const result = await harness.invoke<FilterOptions>('getFilterOptions', { payload: {} });

    expect(result.data.users).toHaveLength(1);
    expect(result.data.users[0].displayName).toBe('Alice Smith');
  });

  // Scoping the Users dropdown by project used to enumerate every issue in
  // the project and fetch every one of those issues' full worklog list just
  // to collect distinct authors — a severe performance bottleneck for large
  // projects. It now calls Jira's assignable-user search directly instead.
  describe('with projectKeys (scoped to a project)', () => {
    it('resolves users via assignable-user search rather than enumerating issues/worklogs', async () => {
      addProjectFixture([]);
      addEpicFixture([]);
      addIssueTypeFixture([]);
      harness.addFixture('GET', '/rest/api/3/user/assignable/multiProjectSearch', {
        status: 200,
        body: [
          { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian', active: true },
          { accountId: 'user2', displayName: 'Bob Jones', accountType: 'atlassian', active: true },
        ],
      });

      const result = await harness.invoke<FilterOptions>('getFilterOptions', {
        payload: { projectKeys: ['PROJ'] },
      });

      expect(result.data.users).toHaveLength(2);
      expect(result.data.users.map((u) => u.displayName)).toEqual(['Alice Smith', 'Bob Jones']);
    });

    it('excludes inactive/non-human/blank-name users from the scoped list', async () => {
      addProjectFixture([]);
      addEpicFixture([]);
      addIssueTypeFixture([]);
      harness.addFixture('GET', '/rest/api/3/user/assignable/multiProjectSearch', {
        status: 200,
        body: [
          { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian', active: true },
          { accountId: 'user2', displayName: 'Deactivated User', accountType: 'atlassian', active: false },
          { accountId: 'bot1', displayName: 'Automation Bot', accountType: 'app', active: true },
          { accountId: 'user3', displayName: '', accountType: 'atlassian', active: true },
        ],
      });

      const result = await harness.invoke<FilterOptions>('getFilterOptions', {
        payload: { projectKeys: ['PROJ'] },
      });

      expect(result.data.users).toHaveLength(1);
      expect(result.data.users[0].displayName).toBe('Alice Smith');
    });
  });
});

// ===========================================================================
// getFilterPresets
// ===========================================================================

describe('getFilterPresets', () => {
  it('returns empty presets array when no storage data exists', async () => {
    const result = await harness.invoke<FilterPresetsResponse>('getFilterPresets', {
      payload: {},
    });

    expect(result.data.presets).toEqual([]);
  });

  it('returns presets from storage after saving', async () => {
    // First save a preset
    await harness.invoke('saveFilterPreset', {
      payload: validPresetPayload({ name: 'Saved Preset' }),
    });

    // Then retrieve
    const result = await harness.invoke<FilterPresetsResponse>('getFilterPresets', {
      payload: {},
    });

    expect(result.data.presets).toHaveLength(1);
    expect(result.data.presets[0].name).toBe('Saved Preset');
    expect(result.data.presets[0].projectKeys).toEqual(['PROJ']);
  });
});

// ===========================================================================
// User preferences (sticky Period)
// ===========================================================================

describe('user preferences', () => {
  it('returns an empty object for a user who has never saved anything', async () => {
    const result = await harness.invoke<UserPreferences>('getUserPreferences', { payload: {} });

    expect(result.data.period).toBeUndefined();
  });

  it('round-trips the last selected period', async () => {
    await harness.invoke('saveUserPreferences', { payload: { period: 'month' } });

    const result = await harness.invoke<UserPreferences>('getUserPreferences', { payload: {} });
    expect(result.data.period).toBe('month');
  });

  it('overwrites a previously stored period', async () => {
    await harness.invoke('saveUserPreferences', { payload: { period: 'day' } });
    await harness.invoke('saveUserPreferences', { payload: { period: 'week' } });

    const result = await harness.invoke<UserPreferences>('getUserPreferences', { payload: {} });
    expect(result.data.period).toBe('week');
  });

  it('rejects a period that is not a real period value', async () => {
    await expect(
      harness.invoke('saveUserPreferences', { payload: { period: 'fortnight' } }),
    ).rejects.toThrow('Invalid period');
  });

  it('ignores a stored period that is no longer a valid value', async () => {
    // Reading is deliberately defensive: storage may hold values written by
    // an older build of the app.
    await harness.storage.set('user-prefs:test-account-id', { period: 'decade' });

    const result = await harness.invoke<UserPreferences>('getUserPreferences', { payload: {} });
    expect(result.data.period).toBeUndefined();
  });
});

// ===========================================================================
// saveFilterPreset
// ===========================================================================

describe('saveFilterPreset', () => {
  it('saves a new preset successfully', async () => {
    const result = await harness.invoke<SaveFilterResponse>('saveFilterPreset', {
      payload: validPresetPayload(),
    });

    expect(result.data.success).toBe(true);
    expect(result.data.name).toBe('My Preset');
  });

  it('validates that name is required', async () => {
    await expect(
      harness.invoke('saveFilterPreset', {
        payload: validPresetPayload({ name: '' }),
      }),
    ).rejects.toThrow('Preset name is required');
  });

  it('validates that name must not be only whitespace', async () => {
    await expect(
      harness.invoke('saveFilterPreset', {
        payload: validPresetPayload({ name: '   ' }),
      }),
    ).rejects.toThrow('Preset name is required');
  });

  it('validates projectKeys must be an array if provided', async () => {
    await expect(
      harness.invoke('saveFilterPreset', {
        payload: validPresetPayload({ projectKeys: 'not-an-array' }),
      }),
    ).rejects.toThrow('projectKeys must be an array');
  });

  it('validates startDate and endDate are required', async () => {
    await expect(
      harness.invoke('saveFilterPreset', {
        payload: validPresetPayload({ startDate: '', endDate: '' }),
      }),
    ).rejects.toThrow('startDate and endDate are required');
  });

  it('validates period is required', async () => {
    await expect(
      harness.invoke('saveFilterPreset', {
        payload: validPresetPayload({ period: '' }),
      }),
    ).rejects.toThrow('period is required');
  });

  it('validates timeUnit is required', async () => {
    await expect(
      harness.invoke('saveFilterPreset', {
        payload: validPresetPayload({ timeUnit: '' }),
      }),
    ).rejects.toThrow('timeUnit is required');
  });

  it('accepts missing timeZone (auto-detected on frontend)', async () => {
    const result = await harness.invoke<SaveFilterResponse>('saveFilterPreset', {
      payload: validPresetPayload({ timeZone: '' }),
    });
    expect(result.data.success).toBe(true);
  });

  it('overwrites existing preset with same name (case-insensitive)', async () => {
    // Save first version
    await harness.invoke('saveFilterPreset', {
      payload: validPresetPayload({ name: 'Weekly', startDate: '2025-01-01', endDate: '2025-01-07' }),
    });

    // Save second version with same name (different case)
    await harness.invoke('saveFilterPreset', {
      payload: validPresetPayload({ name: 'weekly', startDate: '2025-02-01', endDate: '2025-02-07' }),
    });

    // Should only have one preset, with the updated dates
    const result = await harness.invoke<FilterPresetsResponse>('getFilterPresets', {
      payload: {},
    });

    expect(result.data.presets).toHaveLength(1);
    expect(result.data.presets[0].name).toBe('weekly');
    expect(result.data.presets[0].startDate).toBe('2025-02-01');
  });

  it('appends a new preset when name is different', async () => {
    await harness.invoke('saveFilterPreset', {
      payload: validPresetPayload({ name: 'Preset A' }),
    });
    await harness.invoke('saveFilterPreset', {
      payload: validPresetPayload({ name: 'Preset B' }),
    });

    const result = await harness.invoke<FilterPresetsResponse>('getFilterPresets', {
      payload: {},
    });

    expect(result.data.presets).toHaveLength(2);
  });
});

// ===========================================================================
// getWorklogReport
// ===========================================================================

describe('getWorklogReport', () => {
  it('accepts empty projectKeys and returns results for all accessible projects', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: { issues: [] },
    });

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ projectKeys: [] }),
    });

    expect(result.data.rows).toEqual([]);
  });

  it('accepts missing projectKeys and returns results for all accessible projects', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: { issues: [] },
    });

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: {
        startDate: '2025-01-15',
        endDate: '2025-01-15',
        period: 'day',
        groupBy: ['issue'],
        grandTotal: false,
      },
    });

    expect(result.data.rows).toEqual([]);
  });

  it('throws when startDate is missing', async () => {
    await expect(
      harness.invoke('getWorklogReport', {
        payload: validReportPayload({ startDate: '' }),
      }),
    ).rejects.toThrow('startDate is required');
  });

  it('throws when endDate is missing', async () => {
    await expect(
      harness.invoke('getWorklogReport', {
        payload: validReportPayload({ endDate: '' }),
      }),
    ).rejects.toThrow('endDate is required');
  });

  it('returns empty rows when no issues match', async () => {
    // POST search returns no issues
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: { issues: [] },
    });

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload(),
    });

    expect(result.data.rows).toEqual([]);
    expect(result.data.grandTotal).toBeNull();
  });

  it('returns report with worklog data grouped by issue', async () => {
    // Issues search
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Implement feature',
              issuetype: { name: 'Story' },
              status: { name: 'In Progress' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: { accountId: 'user1', displayName: 'Alice Smith' },
            },
          },
        ],
      },
    });

    // Worklogs for PROJ-10
    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 7200, // 2 hours
      },
    ]);

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload(),
    });

    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].groupColumns).toEqual([
      { dimension: 'issue', label: 'PROJ-10: Implement feature' },
    ]);
    expect(result.data.rows[0].rowTotalHours).toBe(2);
    expect(result.data.rows[0].dateHours).toEqual([
      { dateLabel: '2025-01-15', hours: 2, hasEmptyComment: true },
    ]);
    expect(result.data.groupColumnHeaders).toEqual(['Issue']);
  });

  it('calculates grand total when requested', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Task A',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 3600, // 1 hour
      },
      {
        id: '2',
        author: { accountId: 'user2', displayName: 'Bob Jones' },
        started: '2025-01-15T14:00:00.000+0000',
        timeSpentSeconds: 5400, // 1.5 hours
      },
    ]);

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ grandTotal: true }),
    });

    expect(result.data.grandTotal).not.toBeNull();
    expect(result.data.grandTotal!.grandTotalHours).toBe(2.5);
  });

  it('excludes bot-authored worklogs from report', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Task A',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 3600,
      },
      {
        id: '2',
        author: { accountId: 'bot1', displayName: 'Automation Bot', accountType: 'app' },
        started: '2025-01-15T12:00:00.000+0000',
        timeSpentSeconds: 7200,
      },
    ]);

    // User lookup fixture (prefix match covers all accountId query params)
    harness.addFixture('GET', '/rest/api/3/user', {
      status: 200,
      body: { accountId: 'user1', displayName: 'Alice Smith' },
    });

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ groupBy: ['author'] }),
    });

    // Only human-authored worklog should be included
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].groupColumns[0].label).toBe('Alice Smith');
    expect(result.data.rows[0].rowTotalHours).toBe(1);
  });

  it('groups by author dimension and resolves display names', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Task A',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 3600,
      },
      {
        id: '2',
        author: { accountId: 'user2', displayName: 'Bob Jones' },
        started: '2025-01-15T14:00:00.000+0000',
        timeSpentSeconds: 7200,
      },
    ]);

    // User lookup fixture (prefix match — the harness returns the same body for all
    // /rest/api/3/user requests regardless of query params, so both user1 and user2
    // resolve to the same displayName "Alice Smith". This means they merge into one
    // row. We verify the resolver calls the user API and the total hours are correct.)
    harness.addFixture('GET', '/rest/api/3/user', {
      status: 200,
      body: { accountId: 'user1', displayName: 'Alice Smith' },
    });

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ groupBy: ['author'] }),
    });

    expect(result.data.groupColumnHeaders).toEqual(['Author']);
    // Both users resolve to same displayName via the fixture, so they merge into one row
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].groupColumns[0].label).toBe('Alice Smith');
    // Total hours: user1=1h + user2=2h = 3h merged
    expect(result.data.rows[0].rowTotalHours).toBe(3);
  });

  // Regression coverage for a real report discrepancy: a worklog started
  // late at night in UTC ("2026-07-31T22:58:00.000+0000") was previously
  // re-projected into the report's own `timeZone` param before its calendar
  // date was read for bucketing — pushing it onto the *next* day (or even
  // the next week) purely because of which timezone happened to be viewing
  // the report, with no relation to the date the work was actually logged
  // against. Bucketing must use the date baked into `started` directly.
  it('buckets a worklog by the calendar date in "started" (Period=Day), not a timezone-shifted date', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PKP-93',
            fields: {
              summary: 'Raytac Module - schematic and PCB layout modification',
              issuetype: { name: 'Task' },
              status: { name: 'In Progress' },
              project: { key: 'PKP', name: 'Perikarpio (VectraCor)' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PKP-93', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Hitesh' },
        started: '2026-07-31T22:58:00.000+0000',
        timeSpentSeconds: 108000, // 30 hours
      },
    ]);

    // Asia/Calcutta (+5:30) would previously shift 22:58 UTC on Jul 31 to
    // 04:28 local on Aug 1 before reading the calendar date.
    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({
        startDate: '2026-07-31',
        endDate: '2026-08-01',
        period: 'day',
        groupBy: ['issue'],
        timeZone: 'Asia/Calcutta',
      }),
    });

    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].dateHours).toEqual([
      { dateLabel: '2026-07-31', hours: 30, hasEmptyComment: true },
      { dateLabel: '2026-08-01', hours: 0, hasEmptyComment: false },
    ]);
  });

  // Root-cause regression: the worklog API's startedAfter/startedBefore
  // window used to be computed as *local midnight in the report's timeZone*.
  // For a positive-offset zone (e.g. IST, UTC+5:30) that pulls the upper
  // bound BACK by the offset, so a worklog whose `started` instant sits late
  // in the day in UTC (e.g. 2026-07-31T22:58Z) fell outside the window and
  // was never fetched at all — no in-memory bucketing fix could recover it.
  // The window must be wide enough to always include any worklog whose own
  // `started` date could land inside the requested range.
  it('requests a worklog fetch window wide enough to include late-in-day worklogs at the range edges', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PKP-93',
            fields: {
              summary: 'Raytac Module',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PKP', name: 'Perikarpio (VectraCor)' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });
    addWorklogFixture('PKP-93', []);

    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({
        startDate: '2026-07-27',
        endDate: '2026-07-31',
        period: 'day',
        timeZone: 'Asia/Calcutta',
      }),
    });

    const worklogCall = harness.apiCalls.find((c) => c.path.includes('/worklog'));
    expect(worklogCall).toBeDefined();
    const params = new URLSearchParams(worklogCall!.path.split('?')[1] ?? '');
    const startedAfter = Number(params.get('startedAfter'));
    const startedBefore = Number(params.get('startedBefore'));

    // A worklog logged for Jul 31 but whose instant is 22:58 UTC must fall
    // inside the requested window.
    const lateOnLastDay = new Date('2026-07-31T22:58:00.000+0000').getTime();
    expect(startedAfter).toBeLessThanOrEqual(lateOnLastDay);
    expect(startedBefore).toBeGreaterThan(lateOnLastDay);

    // ...and so must one logged for the first day but recorded with a
    // negative-offset (e.g. UTC-11) that puts its instant before UTC midnight.
    const earlyOnFirstDay = new Date('2026-07-27T00:30:00.000-1100').getTime();
    expect(startedAfter).toBeLessThanOrEqual(earlyOnFirstDay);
  });

  it('buckets a worklog into the correct ISO week from "started", not a timezone-shifted week', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PKP-93',
            fields: {
              summary: 'Raytac Module - schematic and PCB layout modification',
              issuetype: { name: 'Task' },
              status: { name: 'In Progress' },
              project: { key: 'PKP', name: 'Perikarpio (VectraCor)' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PKP-93', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Hitesh' },
        started: '2026-07-31T22:58:00.000+0000', // Friday
        timeSpentSeconds: 108000, // 30 hours
      },
    ]);

    // Range spans the week containing Jul 31 (Mon 27 Jul - Sun 02 Aug) and the
    // following week (Mon 03 Aug - Sun 09 Aug) — the worklog must land in the
    // former, never the latter.
    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({
        startDate: '2026-07-27',
        endDate: '2026-08-09',
        period: 'week',
        groupBy: ['issue'],
        timeZone: 'Asia/Calcutta',
      }),
    });

    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].dateHours).toEqual([
      { dateLabel: '2026-07-27', hours: 30, hasEmptyComment: true },
      { dateLabel: '2026-08-03', hours: 0, hasEmptyComment: false },
    ]);
  });
});

// ===========================================================================
// JQL filter override
// ===========================================================================

describe('stripTrailingOrderBy', () => {
  it('removes a trailing ORDER BY clause', () => {
    expect(stripTrailingOrderBy('project = ABC ORDER BY created DESC')).toBe('project = ABC');
  });

  it('is case-insensitive and tolerates extra whitespace', () => {
    expect(stripTrailingOrderBy('project = ABC   order   by   key asc')).toBe('project = ABC');
  });

  it('leaves JQL without an ORDER BY untouched', () => {
    expect(stripTrailingOrderBy('project = ABC AND labels = urgent')).toBe('project = ABC AND labels = urgent');
  });

  it('does NOT strip "order by" appearing inside a quoted value', () => {
    expect(stripTrailingOrderBy('summary ~ "order by date"')).toBe('summary ~ "order by date"');
  });

  it('strips the ORDER BY but keeps a quoted value containing "order by"', () => {
    expect(stripTrailingOrderBy('summary ~ "order by date" ORDER BY created DESC')).toBe(
      'summary ~ "order by date"',
    );
  });
});

/** The JQL the resolver actually sent to Jira's search endpoint. */
function sentJql(): string {
  const call = harness.apiCalls.find(
    (c) => c.method.toUpperCase() === 'POST' && c.path.startsWith('/rest/api/3/search/jql'),
  );
  return (call?.body as { jql?: string } | undefined)?.jql ?? '';
}

describe("getWorklogReport's Users filter", () => {
  beforeEach(() => {
    harness.addFixture('POST', '/rest/api/3/search/jql', { status: 200, body: { issues: [] } });
  });

  // Regression: this clause used to be emitted as `assignee in (...)`, which
  // silently dropped every hour a user logged against an issue assigned to
  // someone else. A real five-day, single-user report came back as 20h
  // instead of 40h because only 2 of the 8 issues they'd logged time on were
  // assigned to them. "Users" in a worklog report means who logged the time.
  it('filters on worklogAuthor, not assignee', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ filters: { authors: ['acct-1'] } }),
    });

    const jql = sentJql();
    expect(jql).toContain('worklogAuthor in ("acct-1")');
    expect(jql).not.toContain('assignee');
  });

  it('includes every selected user in the worklogAuthor clause', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ filters: { authors: ['acct-1', 'acct-2'] } }),
    });

    expect(sentJql()).toContain('worklogAuthor in ("acct-1", "acct-2")');
  });

  it('omits the clause entirely when no users are selected', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ filters: { authors: [] } }),
    });

    expect(sentJql()).not.toContain('worklogAuthor');
  });

  it('still narrows to the selected users per worklog, not just per issue', async () => {
    // worklogAuthor + worklogDate match independently in Jira, so the search
    // returns issues that merely *contain* a matching worklog. The per-worklog
    // filtering has to happen in memory afterwards — otherwise a colleague's
    // hours on a shared issue would leak into the selected user's totals.
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          { key: 'PROJ-1', fields: { summary: 'Shared issue', issuetype: { name: 'Task' } } },
        ],
      },
    });
    harness.addFixture('GET', '/rest/api/3/issue/PROJ-1/worklog', {
      status: 200,
      body: {
        worklogs: [
          {
            author: { accountId: 'acct-1', displayName: 'Wanted', accountType: 'atlassian' },
            started: '2025-01-15T09:00:00.000+0000',
            created: '2025-01-15T09:00:00.000+0000',
            timeSpentSeconds: 3600,
          },
          {
            author: { accountId: 'acct-9', displayName: 'Somebody else', accountType: 'atlassian' },
            started: '2025-01-15T10:00:00.000+0000',
            created: '2025-01-15T10:00:00.000+0000',
            timeSpentSeconds: 7200,
          },
        ],
      },
    });

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ filters: { authors: ['acct-1'] } }),
    });

    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].rowTotalHours).toBe(1);
  });
});

describe('getWorklogEntriesPage (Export Comments)', () => {
  /** Two issues, three worklogs, two authors, two comment shapes. */
  function seedTwoIssues() {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-1',
            fields: {
              summary: 'Build the thing',
              issuetype: { name: 'Task' },
              project: { key: 'PROJ', name: 'Project Alpha' },
            },
          },
          {
            key: 'PROJ-2',
            fields: {
              summary: 'Fix the thing',
              issuetype: { name: 'Bug' },
              project: { key: 'PROJ', name: 'Project Alpha' },
            },
          },
        ],
      },
    });
    harness.addFixture('GET', '/rest/api/3/issue/PROJ-1/worklog', {
      status: 200,
      body: {
        worklogs: [
          {
            author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
            started: '2025-01-15T09:00:00.000+0000',
            created: '2025-01-15T09:30:00.000+0000',
            timeSpentSeconds: 3600,
            // ADF comment — must be flattened to plain text.
            comment: {
              type: 'doc',
              version: 1,
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Reviewed the spec' }] },
              ],
            },
          },
          {
            author: { accountId: 'user2', displayName: 'Bob Jones', accountType: 'atlassian' },
            started: '2025-01-15T11:00:00.000+0000',
            created: '2025-01-15T11:05:00.000+0000',
            timeSpentSeconds: 1800,
            // No comment at all — must still produce a row, with a blank one.
          },
        ],
      },
    });
    harness.addFixture('GET', '/rest/api/3/issue/PROJ-2/worklog', {
      status: 200,
      body: {
        worklogs: [
          {
            author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
            started: '2025-01-15T14:00:00.000+0000',
            created: '2025-01-15T14:10:00.000+0000',
            timeSpentSeconds: 7200,
            comment: 'Plain string comment',
          },
        ],
      },
    });
  }

  it('returns one row per worklog, with comments flattened to plain text', async () => {
    seedTwoIssues();

    const result = await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload: validReportPayload(),
    });

    expect(result.data.entries).toHaveLength(3);

    const alice1 = result.data.entries.find((e) => e.issueKey === 'PROJ-1' && e.timeSpentHours === 1);
    expect(alice1).toMatchObject({
      issueKey: 'PROJ-1',
      issueSummary: 'Build the thing',
      projectKey: 'PROJ',
      issueType: 'Task',
      authorDisplayName: 'Alice Smith',
      loggedDate: '2025-01-15',
      timeSpentHours: 1,
      comment: 'Reviewed the spec',
    });
  });

  it('keeps worklogs that have no comment, rather than dropping them', async () => {
    seedTwoIssues();

    const result = await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload: validReportPayload(),
    });

    const bob = result.data.entries.find((e) => e.authorDisplayName === 'Bob Jones');
    expect(bob).toBeDefined();
    expect(bob!.comment).toBe('');
    expect(bob!.timeSpentHours).toBe(0.5);
  });

  it('passes through a plain-string comment unchanged', async () => {
    seedTwoIssues();

    const result = await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload: validReportPayload(),
    });

    const entry = result.data.entries.find((e) => e.issueKey === 'PROJ-2');
    expect(entry!.comment).toBe('Plain string comment');
  });

  // The whole point of sharing fetchWorklogPage between the report and this
  // export: if these two ever disagree, the export stops being a breakdown of
  // the report and becomes a second, contradictory source of truth.
  it('totals to exactly the same hours as the report over the same filters', async () => {
    seedTwoIssues();
    const payload = validReportPayload({ grandTotal: true });

    const report = await harness.invoke<WorklogReportResponse>('getWorklogReport', { payload });

    harness.reset();
    seedTwoIssues();
    const entries = await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload,
    });

    const exportTotal = entries.data.entries.reduce((sum, e) => sum + e.timeSpentHours, 0);
    expect(exportTotal).toBeCloseTo(report.data.grandTotal!.grandTotalHours, 5);
    expect(exportTotal).toBeCloseTo(3.5, 5);
  });

  it('honours the Users filter, exactly like the report does', async () => {
    seedTwoIssues();

    const result = await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload: validReportPayload({ filters: { authors: ['user1'] } }),
    });

    expect(result.data.entries).toHaveLength(2);
    expect(result.data.entries.every((e) => e.authorDisplayName === 'Alice Smith')).toBe(true);
    // ...and the same worklogAuthor clause the report builds.
    expect(sentJql()).toContain('worklogAuthor in ("user1")');
  });

  it('honours a JQL override', async () => {
    seedTwoIssues();

    await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload: validReportPayload({ jql: 'labels = urgent' }),
    });

    const jql = sentJql();
    expect(jql).toContain('(labels = urgent)');
    expect(jql).not.toContain('project in');
  });

  it('excludes worklogs outside the date range', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [{ key: 'PROJ-1', fields: { summary: 'Thing', issuetype: { name: 'Task' } } }],
      },
    });
    harness.addFixture('GET', '/rest/api/3/issue/PROJ-1/worklog', {
      status: 200,
      body: {
        worklogs: [
          {
            author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
            started: '2025-01-15T09:00:00.000+0000',
            created: '2025-01-15T09:00:00.000+0000',
            timeSpentSeconds: 3600,
            comment: 'In range',
          },
          {
            author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
            started: '2025-01-17T09:00:00.000+0000',
            created: '2025-01-17T09:00:00.000+0000',
            timeSpentSeconds: 3600,
            comment: 'Out of range',
          },
        ],
      },
    });

    const result = await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload: validReportPayload(),
    });

    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].comment).toBe('In range');
  });

  it('excludes bot/app-authored worklogs, like the report does', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [{ key: 'PROJ-1', fields: { summary: 'Thing', issuetype: { name: 'Task' } } }],
      },
    });
    harness.addFixture('GET', '/rest/api/3/issue/PROJ-1/worklog', {
      status: 200,
      body: {
        worklogs: [
          {
            author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
            started: '2025-01-15T09:00:00.000+0000',
            created: '2025-01-15T09:00:00.000+0000',
            timeSpentSeconds: 3600,
            comment: 'Human',
          },
          {
            author: { accountId: 'bot1', displayName: 'Jira Bot', accountType: 'app' },
            started: '2025-01-15T10:00:00.000+0000',
            created: '2025-01-15T10:00:00.000+0000',
            timeSpentSeconds: 3600,
            comment: 'Automated',
          },
        ],
      },
    });

    const result = await harness.invoke<WorklogEntriesResponse>('getWorklogEntriesPage', {
      payload: validReportPayload(),
    });

    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].comment).toBe('Human');
  });

  it('requires startDate and endDate', async () => {
    await expect(
      harness.invoke('getWorklogEntriesPage', { payload: { projectKeys: [], endDate: '2025-01-15' } }),
    ).rejects.toThrow('startDate is required');
  });
});

describe('getWorklogReport with a JQL override', () => {
  beforeEach(() => {
    harness.addFixture('POST', '/rest/api/3/search/jql', { status: 200, body: { issues: [] } });
  });

  it('uses the supplied JQL and drops the project/issuetype/status/user/epic clauses', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({
        projectKeys: ['PROJ', 'BETA'],
        jql: 'labels = urgent',
        filters: {
          issueTypes: ['Bug'],
          statuses: ['Done'],
          authors: ['user1'],
          epics: ['PROJ-1'],
        },
      }),
    });

    const jql = sentJql();
    expect(jql).toContain('(labels = urgent)');
    // Every structured filter must be absent — the JQL replaces them.
    expect(jql).not.toContain('project in');
    expect(jql).not.toContain('issuetype in');
    expect(jql).not.toContain('status in');
    expect(jql).not.toContain('worklogAuthor in');
    expect(jql).not.toContain('parent in');
  });

  it('still applies the worklogDate bounds, so the JQL cannot widen the report range', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ jql: 'labels = urgent' }),
    });

    const jql = sentJql();
    expect(jql).toContain('worklogDate >=');
    expect(jql).toContain('worklogDate <=');
  });

  it('parenthesises the JQL so a top-level OR cannot swallow the date bounds', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ jql: 'project = A OR project = B' }),
    });

    expect(sentJql()).toContain('(project = A OR project = B) AND worklogDate >=');
  });

  it('strips a trailing ORDER BY from the user JQL (Jira rejects it inside parentheses)', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ jql: 'labels = urgent ORDER BY created DESC' }),
    });

    const jql = sentJql();
    expect(jql).toContain('(labels = urgent)');
    // Exactly one ORDER BY remains — the report's own, at the very end.
    expect(jql.match(/ORDER BY/gi)).toHaveLength(1);
    expect(jql.trimEnd().endsWith('ORDER BY key ASC')).toBe(true);
  });

  it('falls back to the structured filters when the JQL is blank/whitespace', async () => {
    await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({ projectKeys: ['PROJ'], jql: '   ' }),
    });

    expect(sentJql()).toContain('project in ("PROJ")');
  });

  it('ignores the Users filter for worklog aggregation when a JQL override is active', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Task A',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });
    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 3600,
      },
      {
        id: '2',
        author: { accountId: 'user2', displayName: 'Bob Jones', accountType: 'atlassian' },
        started: '2025-01-15T11:00:00.000+0000',
        timeSpentSeconds: 7200,
      },
    ]);

    const result = await harness.invoke<WorklogReportResponse>('getWorklogReport', {
      payload: validReportPayload({
        jql: 'labels = urgent',
        // Would normally restrict the report to user1's 1h only.
        filters: { authors: ['user1'] },
        groupBy: ['issue'],
      }),
    });

    // Both users' worklogs counted (1h + 2h) — the stale Users selection must
    // not keep narrowing a JQL-driven report.
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].rowTotalHours).toBe(3);
  });

  it('surfaces Jira\'s own explanation when the JQL is invalid', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 400,
      body: { errorMessages: ["Field 'bogusfield' does not exist or you do not have permission to view it."], errors: {} },
    });

    await expect(
      harness.invoke('getWorklogReport', {
        payload: validReportPayload({ jql: 'bogusfield = 1' }),
      }),
    ).rejects.toThrow(/bogusfield.*does not exist/i);
  });
});

// ===========================================================================
// exportWorklogReport
// ===========================================================================

describe('exportWorklogReport', () => {
  it('accepts empty projectKeys without throwing', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: { issues: [] },
    });

    // Empty projectKeys + no data = throws "No data to export"
    await expect(
      harness.invoke('exportWorklogReport', {
        payload: validReportPayload({ projectKeys: [] }),
      }),
    ).rejects.toThrow('No data to export');
  });

  it('throws when report is empty', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: { issues: [] },
    });

    await expect(
      harness.invoke('exportWorklogReport', {
        payload: validReportPayload({ projectKeys: ['NONEXIST'] }),
      }),
    ).rejects.toThrow('No data to export');
  });

  it('throws when no data to export', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: { issues: [] },
    });

    await expect(
      harness.invoke('exportWorklogReport', {
        payload: validReportPayload(),
      }),
    ).rejects.toThrow('No data to export');
  });

  it('generates CSV with correct headers and data rows', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Implement feature',
              issuetype: { name: 'Story' },
              status: { name: 'In Progress' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 7200, // 2 hours
      },
    ]);

    const result = await harness.invoke<CsvExportResponse>('exportWorklogReport', {
      payload: validReportPayload(),
    });

    expect(result.data.filename).toBe('worklog-report-2025-01-15-to-2025-01-15.csv');
    expect(result.data.csvContent).toBeDefined();

    const lines = result.data.csvContent.split('\n');
    // Header: Issue, Total, 2025-01-15
    expect(lines[0]).toContain('Issue');
    expect(lines[0]).toContain('Total');
    expect(lines[0]).toContain('Wed 15-Jan');
    // Data row should contain the issue label and hours
    expect(lines[1]).toContain('PROJ-10');
    expect(lines[1]).toContain('2');
  });

  it('includes grand total row in CSV when requested', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Task',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 3600,
      },
    ]);

    const result = await harness.invoke<CsvExportResponse>('exportWorklogReport', {
      payload: validReportPayload({ grandTotal: true }),
    });

    const lines = result.data.csvContent.split('\n');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('Grand Total');
  });
});

// ===========================================================================
// getWorklogDetails
// ===========================================================================

describe('getWorklogDetails', () => {
  it('excludes bot-authored worklogs from detail results', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-10',
            fields: {
              summary: 'Task A',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PROJ-10', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
        started: '2025-01-15T10:00:00.000+0000',
        timeSpentSeconds: 3600,
      },
      {
        id: '2',
        author: { accountId: 'bot1', displayName: 'Automation Bot', accountType: 'app' },
        started: '2025-01-15T12:00:00.000+0000',
        timeSpentSeconds: 7200,
      },
    ]);

    const result = await harness.invoke<{ entries: Array<{ issueKey: string; timeSpentHours: number }> }>(
      'getWorklogDetails',
      {
        payload: {
          issueKeys: ['PROJ-10'],
          startDate: '2025-01-15',
          endDate: '2025-01-15',
        },
      },
    );

    // Only human-authored worklog should appear in details
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].issueKey).toBe('PROJ-10');
    expect(result.data.entries[0].timeSpentHours).toBe(1);
  });

  it('returns createdDate (worklog creation timestamp) distinct from started, and a bucketKey per entry', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PROJ-11',
            fields: {
              summary: 'Task B',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PROJ', name: 'Project Alpha' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PROJ-11', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Alice Smith', accountType: 'atlassian' },
        // Logged against Jan 15, but not actually *created* in Jira until
        // the next day — these two timestamps must not be conflated.
        started: '2025-01-15T10:00:00.000+0000',
        created: '2025-01-16T08:30:00.000+0000',
        timeSpentSeconds: 3600,
      } as unknown as { id: string; author: { accountId: string; displayName: string; accountType?: string }; started: string; timeSpentSeconds: number },
    ]);

    const result = await harness.invoke<{
      entries: Array<{ issueKey: string; createdDate: string; bucketKey: string }>;
    }>('getWorklogDetails', {
      payload: {
        issueKeys: ['PROJ-11'],
        startDate: '2025-01-15',
        endDate: '2025-01-15',
        period: 'day',
      },
    });

    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].createdDate).toBe('2025-01-16T08:30:00.000+0000');
    // day period bucketKey is the worked (started) date, not the created date
    expect(result.data.entries[0].bucketKey).toBe('2025-01-15');
  });

  it('computes bucketKey from the raw "started" date, not a timezone-shifted date (matches getWorklogReport)', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: {
        issues: [
          {
            key: 'PKP-93',
            fields: {
              summary: 'Raytac Module - schematic and PCB layout modification',
              issuetype: { name: 'Task' },
              status: { name: 'Done' },
              project: { key: 'PKP', name: 'Perikarpio (VectraCor)' },
              parent: null,
              assignee: null,
            },
          },
        ],
      },
    });

    addWorklogFixture('PKP-93', [
      {
        id: '1',
        author: { accountId: 'user1', displayName: 'Hitesh' },
        started: '2026-07-31T22:58:00.000+0000',
        timeSpentSeconds: 108000, // 30 hours
      },
    ]);

    const result = await harness.invoke<{ entries: Array<{ bucketKey: string }> }>('getWorklogDetails', {
      payload: {
        issueKeys: ['PKP-93'],
        startDate: '2026-07-27',
        endDate: '2026-08-09',
        period: 'week',
        // Asia/Calcutta (+5:30) would previously shift 22:58 UTC on Jul 31 to
        // Aug 1 local before computing the bucket — landing this in the
        // wrong week bucket ("2026-08-03" instead of "2026-07-27").
        timeZone: 'Asia/Calcutta',
      },
    });

    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].bucketKey).toBe('2026-07-27');
  });
});

// ===========================================================================
// logError
// ===========================================================================

describe('logError', () => {
  it('accepts error data and returns success', async () => {
    const result = await harness.invoke<{ success: boolean }>('logError', {
      payload: {
        message: 'Something went wrong',
        stack: 'Error: Something went wrong\n    at App.tsx:42',
        source: 'frontend',
        timestamp: '2025-01-15T10:00:00.000Z',
      },
    });

    expect(result.data.success).toBe(true);
  });

  it('handles minimal error payload', async () => {
    const result = await harness.invoke<{ success: boolean }>('logError', {
      payload: {
        message: 'Oops',
        timestamp: '2025-01-15T10:00:00.000Z',
      },
    });

    expect(result.data.success).toBe(true);
  });
});

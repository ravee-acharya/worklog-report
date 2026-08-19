import { createTestHarness } from '@forge/testing-framework';
import { handler } from '../resolvers';
import type {
  FilterPresetsResponse,
  SaveFilterResponse,
  FilterOptions,
  WorklogReportResponse,
} from '../types/worklog-types';

const harness = createTestHarness({
  manifest: './manifest.yml',
  handlers: { resolver: handler },
});

beforeEach(() => harness.reset());

// ---------------------------------------------------------------------------
// Helper: add default API fixtures so resolvers that hit Jira APIs don't fail
// ---------------------------------------------------------------------------

function addDefaultApiFixtures() {
  harness.addFixture('GET', '/rest/api/3/project/search', {
    status: 200,
    body: { values: [], isLast: true, startAt: 0, maxResults: 100 },
  });
  harness.addFixture('GET', '/rest/api/3/users/search', {
    status: 200,
    body: [],
  });
  harness.addFixture('POST', '/rest/api/3/search/jql', {
    status: 200,
    body: { issues: [] },
  });
  harness.addFixture('GET', '/rest/api/3/issuetype', {
    status: 200,
    body: [],
  });
}

// ===========================================================================
// Integration: save and retrieve filter presets
// ===========================================================================

describe('Filter preset round-trip', () => {
  it('saves a preset then retrieves it intact', async () => {
    const preset = {
      name: 'Sprint 42',
      projectKeys: ['PROJ', 'BETA'],
      startDate: '2025-03-01',
      endDate: '2025-03-14',
      period: 'custom' as const,
      timeUnit: 'decimal' as const,
      timeZone: 'America/New_York',
      grandTotal: true,
      filters: {
        issueTypes: ['Story', 'Bug'],
        authors: ['user1'],
      },
    };

    // Save
    const saveResult = await harness.invoke<SaveFilterResponse>(
      'saveFilterPreset',
      { payload: preset },
    );
    expect(saveResult.data.success).toBe(true);
    expect(saveResult.data.name).toBe('Sprint 42');

    // Retrieve
    const getResult = await harness.invoke<FilterPresetsResponse>(
      'getFilterPresets',
      { payload: {} },
    );
    expect(getResult.data.presets).toHaveLength(1);

    const saved = getResult.data.presets[0];
    expect(saved.name).toBe('Sprint 42');
    expect(saved.projectKeys).toEqual(['PROJ', 'BETA']);
    expect(saved.startDate).toBe('2025-03-01');
    expect(saved.endDate).toBe('2025-03-14');
    expect(saved.period).toBe('custom');
    expect(saved.timeUnit).toBe('decimal');
    expect(saved.timeZone).toBe('America/New_York');
    expect(saved.grandTotal).toBe(true);
    expect(saved.filters?.issueTypes).toEqual(['Story', 'Bug']);
    expect(saved.filters?.authors).toEqual(['user1']);
  });

  it('saves multiple presets and retrieves all of them', async () => {
    const base = {
      projectKeys: ['PROJ'],
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      period: 'month' as const,
      timeUnit: 'decimal' as const,
      timeZone: 'UTC',
      grandTotal: false,
    };

    await harness.invoke('saveFilterPreset', {
      payload: { ...base, name: 'January' },
    });
    await harness.invoke('saveFilterPreset', {
      payload: { ...base, name: 'February', startDate: '2025-02-01', endDate: '2025-02-28' },
    });

    const result = await harness.invoke<FilterPresetsResponse>(
      'getFilterPresets',
      { payload: {} },
    );
    expect(result.data.presets).toHaveLength(2);
    const names = result.data.presets.map((p) => p.name);
    expect(names).toContain('January');
    expect(names).toContain('February');
  });
});

// ===========================================================================
// Cold start: all resolvers handle empty storage without errors
// ===========================================================================

describe('Cold start', () => {
  it('getFilterOptions handles empty state', async () => {
    addDefaultApiFixtures();

    const result = await harness.invoke<FilterOptions>(
      'getFilterOptions',
      { payload: {} },
    );

    expect(result.data).toBeDefined();
    expect(result.data.projects).toEqual([]);
    expect(result.data.users).toEqual([]);
    expect(result.data.epics).toEqual([]);
    expect(result.data.issueTypes).toEqual([]);
  });

  it('getFilterPresets returns empty array on cold start', async () => {
    const result = await harness.invoke<FilterPresetsResponse>(
      'getFilterPresets',
      { payload: {} },
    );

    expect(result.data).toBeDefined();
    expect(result.data.presets).toEqual([]);
  });

  it('getWorklogReport returns empty rows on cold start', async () => {
    harness.addFixture('POST', '/rest/api/3/search/jql', {
      status: 200,
      body: { issues: [] },
    });

    const result = await harness.invoke<WorklogReportResponse>(
      'getWorklogReport',
      {
        payload: {
          projectKeys: ['PROJ'],
          startDate: '2025-01-01',
          endDate: '2025-01-31',
          period: 'month',
          groupBy: ['issue'],
          grandTotal: false,
        },
      },
    );

    expect(result.data).toBeDefined();
    expect(result.data.rows).toEqual([]);
  });

  it('logError works without any prior state', async () => {
    const result = await harness.invoke<{ success: boolean }>(
      'logError',
      {
        payload: {
          message: 'cold start error',
          timestamp: new Date().toISOString(),
        },
      },
    );

    expect(result.data.success).toBe(true);
  });
});

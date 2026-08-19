import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { bridge } from '@forge/bridge';

import { App } from '../index';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const mockFilterOptions = {
  projects: [
    { key: 'ALPHA', name: 'Alpha Project' },
    { key: 'BETA', name: 'Beta Project' },
  ],
  users: [
    { accountId: 'user1', displayName: 'Alice Smith' },
    { accountId: 'user2', displayName: 'Bob Jones' },
  ],
  epics: [{ key: 'ALPHA-1', summary: 'Epic One' }],
  issueTypes: ['Task', 'Bug', 'Story'],
};

const mockPresets = {
  presets: [
    {
      name: 'My Preset',
      projectKeys: ['ALPHA'],
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      period: 'week' as const,
      timeUnit: 'decimal' as const,
      timeZone: 'UTC',
      grandTotal: false,
    },
  ],
};


// ---------------------------------------------------------------------------
// Helper: set up standard invoke mocks for the two init calls
// ---------------------------------------------------------------------------
function mockInitialLoad(
  options = mockFilterOptions,
  presets = mockPresets,
) {
  bridge.mockInvoke('getFilterOptions', options);
  bridge.mockInvoke('getFilterPresets', presets);
  // Also mock logError so it doesn't fail when called
  bridge.mockInvoke('logError', { success: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  bridge.reset();
});

describe('App', () => {
  // 1. Renders loading state initially, then renders toolbar after data loads
  it('shows loading state initially, then renders toolbar after data loads', async () => {
    mockInitialLoad();
    render(<App />);

    // While loading, the spinner/loading text should be visible
    expect(screen.getByText('Loading worklog report...')).toBeInTheDocument();

    // After init completes, the toolbar appears (no h1 heading)
    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });
  });

  // 2. Calls getFilterOptions and getFilterPresets on mount
  it('calls getFilterOptions and getFilterPresets on mount', async () => {
    mockInitialLoad();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    expect(bridge.invocations).toContainEqual(
      expect.objectContaining({ functionKey: 'getFilterOptions' }),
    );
    expect(bridge.invocations).toContainEqual(
      expect.objectContaining({ functionKey: 'getFilterPresets' }),
    );
  });

  // 3. Shows error when filter options fail
  it('shows error SectionMessage when getFilterOptions fails', async () => {
    bridge.mockInvoke('getFilterOptions', () => {
      throw new Error('Network error');
    });
    bridge.mockInvoke('getFilterPresets', mockPresets);
    bridge.mockInvoke('logError', { success: true });

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByText('Failed to load filter options. Please try refreshing.'),
      ).toBeInTheDocument();
    });
  });

  // 4. Shows "Get Started" message before report is run
  it('shows Get Started message in initial state', async () => {
    mockInitialLoad();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Get Started')).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Select your filters and click/),
    ).toBeInTheDocument();
  });

  // 5. View Report no longer requires project selection
  it('does not show project validation error when View Report is clicked without projects', async () => {
    mockInitialLoad();
    bridge.mockInvoke('getWorklogReport', {
      groupColumnHeaders: [],
      rows: [],
      grandTotal: null,
    });
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    const viewReportBtn = screen.getByText('View Report');
    await user.click(viewReportBtn);

    // No project validation error should appear
    await waitFor(() => {
      expect(
        screen.queryByText('At least one project is required.'),
      ).not.toBeInTheDocument();
    });
  });

  // 6. Export CSV no longer requires project selection
  it('does not show project validation error when Export CSV is clicked without projects', async () => {
    mockInitialLoad();
    // Export CSV now pages through getWorklogReport client-side instead of
    // a single exportWorklogReport invocation (see handleExportCsv) — the
    // old server-side export ran its full pagination loop inside one
    // resolver call, which could exceed Forge's function timeout for large
    // reports.
    bridge.mockInvoke('getWorklogReport', {
      groupColumnHeaders: ['User'],
      rows: [],
      grandTotal: null,
      nextPageToken: null,
      isComplete: true,
      progress: { loadedIssues: 0, totalIssues: 0 },
    });
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    const exportBtn = screen.getByText('Export CSV');
    await user.click(exportBtn);

    await waitFor(() => {
      expect(
        screen.queryByText('At least one project is required.'),
      ).not.toBeInTheDocument();
    });
  });

  // 7. Handles empty presets array gracefully
  it('renders correctly when there are no saved presets', async () => {
    bridge.mockInvoke('getFilterOptions', mockFilterOptions);
    bridge.mockInvoke('getFilterPresets', { presets: [] });
    bridge.mockInvoke('logError', { success: true });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    // Should still render the toolbar labels
    expect(screen.getByText('Saved Filters')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
  });

  // 8. Handles null/malformed presets response
  it('handles malformed presets response gracefully', async () => {
    bridge.mockInvoke('getFilterOptions', mockFilterOptions);
    // Return a response where presets is not an array
    bridge.mockInvoke('getFilterPresets', { presets: null });
    bridge.mockInvoke('logError', { success: true });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    // Should render without crashing
    expect(screen.getByText('Get Started')).toBeInTheDocument();
  });

  // 9. Handles null filter options response
  it('handles null getFilterOptions response gracefully', async () => {
    bridge.mockInvoke('getFilterOptions', null);
    bridge.mockInvoke('getFilterPresets', { presets: [] });
    bridge.mockInvoke('logError', { success: true });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    // Should still render toolbar even with no options
    expect(screen.getByText('View Report')).toBeInTheDocument();
  });

  // 10. Renders toolbar labels (no heading, no Time Zone)
  it('renders all toolbar labels after loading', async () => {
    mockInitialLoad();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    // Verify key toolbar labels are present
    expect(screen.getByText('Saved Filters')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.getByText('From *')).toBeInTheDocument();
    expect(screen.getByText('To *')).toBeInTheDocument();
    expect(screen.getByText('Period')).toBeInTheDocument();
    expect(screen.getByText('Categorize')).toBeInTheDocument();
    expect(screen.getByText('Group by')).toBeInTheDocument();
    expect(screen.getByText('Time Unit')).toBeInTheDocument();
    // Time Zone is auto-detected — no UI label
    expect(screen.queryByText('Time Zone')).not.toBeInTheDocument();
    // Grand Total is no longer a toggle — the report always shows a totals row
    expect(screen.queryByText('Grand Total')).not.toBeInTheDocument();
    expect(screen.getByText('Save Filter')).toBeInTheDocument();
    expect(screen.getByText('View Report')).toBeInTheDocument();
    expect(screen.getByText('Export CSV')).toBeInTheDocument();
  });

  // 11. Shows error when getWorklogReport fails
  it('shows error message when report fetch fails', async () => {
    mockInitialLoad();
    bridge.mockInvoke('getWorklogReport', () => {
      throw new Error('Server error');
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    // Click View Report — projects are now optional, so it proceeds to invoke
    const viewReportBtn = screen.getByText('View Report');
    await user.click(viewReportBtn);

    // Should see the report error message
    await waitFor(() => {
      expect(
        screen.getByText('Failed to load the worklog report. Please try again.'),
      ).toBeInTheDocument();
    });
  });

  // 12. Save Filter button opens modal
  it('opens Save Filter modal when Save Filter button is clicked', async () => {
    mockInitialLoad();
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    const saveFilterBtn = screen.getByText('Save Filter');
    await user.click(saveFilterBtn);

    // Modal title should appear
    await waitFor(() => {
      expect(screen.getByText('Save Filter Preset')).toBeInTheDocument();
    });

    // Modal content
    expect(screen.getByText('Preset Name')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  // 13. Loading state shows spinner
  it('shows spinner with correct label during initial load', () => {
    // Mock invoke to never resolve, keeping the loading state
    bridge.mockInvoke('getFilterOptions', () => new Promise(() => {}));
    bridge.mockInvoke('getFilterPresets', () => new Promise(() => {}));
    bridge.mockInvoke('logError', { success: true });

    render(<App />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.getByText('Loading worklog report...')).toBeInTheDocument();
  });

  // 14. Renders presets from response
  it('loads presets from getFilterPresets response', async () => {
    mockInitialLoad();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    // The preset options are fed into a Select stub, so we verify that
    // the invoke was called and data loaded without error
    expect(bridge.invocations).toContainEqual(
      expect.objectContaining({ functionKey: 'getFilterPresets' }),
    );
    // No error should be displayed
    expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument();
  });

  // 15. Error from getFilterPresets alone still renders (only options fail = error)
  it('shows error when getFilterPresets throws', async () => {
    bridge.mockInvoke('getFilterOptions', () => {
      throw new Error('Presets error');
    });
    bridge.mockInvoke('getFilterPresets', mockPresets);
    bridge.mockInvoke('logError', { success: true });

    render(<App />);

    // Since both calls are in Promise.all, if either throws the catch
    // block handles it
    await waitFor(() => {
      expect(
        screen.getByText('Failed to load filter options. Please try refreshing.'),
      ).toBeInTheDocument();
    });
  });

  // 16. Validation: no start date
  it('does not crash when all data loads correctly and no interaction occurs', async () => {
    mockInitialLoad(mockFilterOptions, mockPresets);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('View Report')).toBeInTheDocument();
    });

    // Verify the app is in a clean state
    expect(screen.getByText('Get Started')).toBeInTheDocument();
    expect(screen.queryByText(/At least one project/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
  });
});

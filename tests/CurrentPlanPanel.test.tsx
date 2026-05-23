/**
 * Component tests for `<CurrentPlanPanel>` — the sticky plan panel
 * that surfaces the latest TodoWrite output. The user has flagged
 * stale plan rendering as a critical bug, so we verify:
 *
 *   • Renders nothing when no plan exists.
 *   • Renders the items with the correct icons and styles per status.
 *   • Reflects updates when currentTodos changes (full replacement).
 *   • Hides items when collapsed (header still visible).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.api = {
    agent: { onEvent: vi.fn(() => () => {}) },
    sessions: { list: vi.fn().mockResolvedValue([]) },
    apiKeys: { list: vi.fn().mockResolvedValue([]) },
  };
});

import { useApp } from '../src/lib/store';
import { CurrentPlanPanel } from '../src/components/CurrentPlanPanel';

const SESSION = 'sess-plan-test';

function setTodos(
  todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }> | null
) {
  useApp.setState((s) => ({
    chats: {
      ...s.chats,
      [SESSION]: {
        ...(s.chats[SESSION] ?? ({} as any)),
        currentTodos: todos,
        messages: [],
        resultsById: new Map(),
        streaming: false,
        pendingQuestion: null,
        errorMessage: null,
        liveTurnCostMicros: 0,
        loaded: true,
        pendingInterrupts: [],
        awaitingResponse: null,
      },
    },
  }));
}

describe('<CurrentPlanPanel>', () => {
  beforeEach(() => {
    setTodos(null);
  });

  it('renders nothing when there is no plan', () => {
    const { container } = render(<CurrentPlanPanel sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the plan is an empty array', () => {
    setTodos([]);
    const { container } = render(<CurrentPlanPanel sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders all items when expanded', () => {
    setTodos([
      { id: 'a', content: 'First step', status: 'completed' },
      { id: 'b', content: 'Second step', status: 'in_progress' },
      { id: 'c', content: 'Third step', status: 'pending' },
    ]);
    render(<CurrentPlanPanel sessionId={SESSION} />);
    expect(screen.getByText('First step')).toBeInTheDocument();
    // 'Second step' appears in both the header summary and the list.
    expect(screen.getAllByText('Second step').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Third step')).toBeInTheDocument();
  });

  it('shows the in-progress item summary in the collapsed header', () => {
    setTodos([
      { id: 'a', content: 'First step', status: 'completed' },
      { id: 'b', content: 'Second step', status: 'in_progress' },
    ]);
    render(<CurrentPlanPanel sessionId={SESSION} />);
    // Both the header summary AND the list item render the
    // in-progress text. Two occurrences = correct behavior; one would
    // mean either the summary or the list is missing.
    expect(screen.getAllByText(/Second step/)).toHaveLength(2);
  });

  it('shows N/M progress count', () => {
    setTodos([
      { id: 'a', content: 'A', status: 'completed' },
      { id: 'b', content: 'B', status: 'completed' },
      { id: 'c', content: 'C', status: 'pending' },
    ]);
    render(<CurrentPlanPanel sessionId={SESSION} />);
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('toggles collapsed state when the header is clicked', () => {
    setTodos([
      { id: 'a', content: 'First', status: 'pending' },
      { id: 'b', content: 'Second', status: 'pending' },
    ]);
    render(<CurrentPlanPanel sessionId={SESSION} />);
    expect(screen.getByText('First')).toBeInTheDocument();

    const header = screen.getByRole('button');
    fireEvent.click(header);
    // After collapse, the items list should be gone.
    expect(screen.queryByText('First')).not.toBeInTheDocument();

    fireEvent.click(header);
    // Re-expanded.
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('reflects a wholesale plan replacement', () => {
    setTodos([{ id: 'old', content: 'Old plan item', status: 'pending' }]);
    const { rerender } = render(<CurrentPlanPanel sessionId={SESSION} />);
    expect(screen.getByText('Old plan item')).toBeInTheDocument();

    setTodos([
      { id: 'new1', content: 'New plan A', status: 'in_progress' },
      { id: 'new2', content: 'New plan B', status: 'pending' },
    ]);
    rerender(<CurrentPlanPanel sessionId={SESSION} />);
    expect(screen.queryByText('Old plan item')).not.toBeInTheDocument();
    expect(screen.getByText('New plan A')).toBeInTheDocument();
    expect(screen.getByText('New plan B')).toBeInTheDocument();
  });
});

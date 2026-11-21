/**
 * Agents panel (design 6.7): the pending-approval badge, Accept / Decline,
 * and that raising trust goes through the confirm dialog (with the expiry
 * picker) while lowering it does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentsPanel, escalationWarning, stateChipClass } from '../../src/components/AgentsPanel';
import type { A2APanelSnapshot } from '../../src/types';

const snap: A2APanelSnapshot = {
  running: true,
  paused: false,
  peers: [
    { peerId: 'dylan', displayName: 'Dylan Murphy', agentKind: 'claude-code', cardUrl: 'https://x', trust: 'inform', effectiveTrust: 'inform', trustPrev: null, trustExpiresTs: null, lastSeenTs: Date.now(), queued: 0 },
  ],
  pending: [
    { taskId: '7f3c0000-1111-2222-3333-444444444444', peerId: 'dylan', direction: 'in', kind: 'request', state: 'TASK_STATE_INPUT_REQUIRED', approval: 'pending', summary: 'which branch has the H3 fix?', sessionId: 's1', lastText: '', updatedTs: Date.now() },
  ],
  tasks: [],
};

const api = {
  snapshot: vi.fn(async () => snap),
  accept: vi.fn(async () => ({ ok: true, message: 'Delivered.' })),
  decline: vi.fn(async () => ({ ok: true, message: 'Declined.' })),
  setTrust: vi.fn(async () => ({ ok: true, message: 'ok' })),
  setPaused: vi.fn(async () => {}),
  invite: vi.fn(),
  revoke: vi.fn(),
  audit: vi.fn(async () => []),
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear();
  (window as any).api = { a2a: api, agent: { onEvent: () => () => {} } };
});

describe('AgentsPanel', () => {
  it('shows the pending badge and Accept / Decline call the API', async () => {
    render(<AgentsPanel open onClose={() => {}} />);
    expect(await screen.findByTestId('a2a-pending-badge')).toHaveTextContent('1');
    expect(screen.getByText(/which branch has the H3 fix/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Accept'));
    await waitFor(() => expect(api.accept).toHaveBeenCalledWith('7f3c0000-1111-2222-3333-444444444444'));
    fireEvent.click(screen.getByText('Decline'));
    await waitFor(() => expect(api.decline).toHaveBeenCalledWith('7f3c0000-1111-2222-3333-444444444444'));
  });

  it('raising trust opens the confirm dialog (full suggests 1 day); nothing changes until confirmed', async () => {
    render(<AgentsPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByText('peers'));
    fireEvent.change(screen.getByLabelText('Trust for dylan'), { target: { value: 'full' } });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/run commands, edit files, and change shared systems without asking you/);
    expect(api.setTrust).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Give full trust'));
    await waitFor(() => expect(api.setTrust).toHaveBeenCalledWith('dylan', 'full', 24 * 3_600_000));
  });

  it('cancel in the dialog changes nothing; lowering trust needs no dialog', async () => {
    render(<AgentsPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByText('peers'));
    fireEvent.change(screen.getByLabelText('Trust for dylan'), { target: { value: 'collaborate' } });
    fireEvent.click(await screen.findByText('Cancel'));
    expect(api.setTrust).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Trust for dylan'), { target: { value: 'blocked' } });
    await waitFor(() => expect(api.setTrust).toHaveBeenCalledWith('dylan', 'blocked', null));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('pause toggle calls setPaused', async () => {
    render(<AgentsPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByText('Pause all A2A'));
    await waitFor(() => expect(api.setPaused).toHaveBeenCalledWith(true));
  });

  it('helpers', () => {
    expect(escalationWarning('Dylan', 'collaborate')).toMatch(/must still ask before destructive/);
    expect(stateChipClass('TASK_STATE_COMPLETED')).toMatch(/green/);
    expect(stateChipClass('TASK_STATE_REJECTED')).toMatch(/red/);
  });
});

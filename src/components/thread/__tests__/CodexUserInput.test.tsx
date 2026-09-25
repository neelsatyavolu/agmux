/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexUserInput } from '../CodexUserInput';

afterEach(() => cleanup());

it('marks only the selected option with the gold data-active choice state (A1)', () => {
  render(<CodexUserInput questions={[
    { id: 'color', question: 'Which color?', options: [{ label: 'Blue', description: 'Cool' }, { label: 'Red', description: 'Warm' }] },
  ]} onSubmit={vi.fn()} />);
  const blueBtn = screen.getByRole('button', { name: /Blue/ });
  const redBtn = screen.getByRole('button', { name: /Red/ });
  expect(blueBtn.className).toContain('ui-choice-item');
  expect(blueBtn.getAttribute('data-active')).toBeNull();
  fireEvent.click(blueBtn);
  expect(blueBtn.getAttribute('data-active')).toBe('true');
  expect(redBtn.getAttribute('data-active')).toBeNull();
});

it('sends independent answers and preserves the form after a failed submission', async () => {
  const submit = vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(undefined);
  render(<CodexUserInput questions={[
    { id: 'color', question: 'Which color?', options: [{ label: 'Blue', description: 'Cool' }] },
    { id: 'name', question: 'Your name?' },
  ]} onSubmit={submit} />);
  fireEvent.click(screen.getByRole('button', { name: /Blue/ }));
  fireEvent.change(screen.getByLabelText('Your name?'), { target: { value: 'Sam' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
  await screen.findByText('Disconnected');
  expect(submit).toHaveBeenCalledWith({ color: { answers: ['Blue'] }, name: { answers: ['Sam'] } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
});

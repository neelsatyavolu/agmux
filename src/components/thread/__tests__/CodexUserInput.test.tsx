/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CodexUserInput } from '../CodexUserInput';

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

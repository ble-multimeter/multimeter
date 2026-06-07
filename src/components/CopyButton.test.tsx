import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CopyButton } from './CopyButton';
import { makeReading } from '../test/readings';

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('CopyButton', () => {
  it('renders nothing when there is no value to copy', () => {
    const { container } = render(
      <CopyButton
        reading={makeReading({ displayText: '', displayValue: null, overload: false })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('copies the reading exactly as shown and confirms', async () => {
    const writeText = mockClipboard();
    render(<CopyButton reading={makeReading({ displayText: '4.762', displayUnit: 'V' })} />);

    fireEvent.click(screen.getByRole('button', { name: /copy reading/i }));

    expect(writeText).toHaveBeenCalledWith('4.762 V');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('copies "OL" on overload', () => {
    const writeText = mockClipboard();
    render(
      <CopyButton
        reading={makeReading({ overload: true, displayText: 'OL', displayValue: null })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy reading/i }));
    expect(writeText).toHaveBeenCalledWith('OL V');
  });
});

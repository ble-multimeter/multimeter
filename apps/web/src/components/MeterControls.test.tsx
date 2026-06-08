import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MeterControls } from './MeterControls';

describe('MeterControls', () => {
  it('renders nothing when the driver exposes no controls', () => {
    const { container } = render(<MeterControls controls={[]} onPress={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only the supported controls, in the fixed label order', () => {
    // Pass them out of order; the component should render Select then Range then Hold.
    render(<MeterControls controls={['hold', 'range', 'select']} onPress={vi.fn()} />);
    const labels = screen.getAllByRole('button').map(b => b.textContent);
    expect(labels).toEqual(['Select', 'Range', 'Hold']);
  });

  it('calls onPress with the control key when a button is clicked', () => {
    const onPress = vi.fn();
    render(<MeterControls controls={['hold', 'maxMin']} onPress={onPress} />);
    fireEvent.click(screen.getByRole('button', { name: 'Max/Min' }));
    expect(onPress).toHaveBeenCalledWith('maxMin');
  });
});

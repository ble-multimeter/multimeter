import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  it('reflects the dark state via aria-checked', () => {
    const { rerender } = render(<ThemeToggle dark={false} onToggle={() => {}} />);
    const sw = screen.getByRole('switch', { name: /dark mode/i });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    rerender(<ThemeToggle dark={true} onToggle={() => {}} />);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(<ThemeToggle dark={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch', { name: /dark mode/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

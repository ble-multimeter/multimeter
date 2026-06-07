import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroReadout } from './HeroReadout';
import { makeReading } from '../test/readings';

describe('HeroReadout', () => {
  it('shows the function, value and unit', () => {
    render(
      <HeroReadout
        reading={makeReading({ function: 'DCV', displayText: '4.762', displayUnit: 'V' })}
      />,
    );
    expect(screen.getByText('DCV')).toBeInTheDocument();
    expect(screen.getByText('4.762')).toBeInTheDocument();
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('renders overload as OL with an "overload" label, not a number', () => {
    render(
      <HeroReadout
        reading={makeReading({ overload: true, displayText: 'OL', displayValue: null })}
      />,
    );
    expect(screen.getByText('OL')).toBeInTheDocument();
    expect(screen.getByText('overload')).toBeInTheDocument();
  });

  it('shows a HOLD badge when held', () => {
    render(<HeroReadout reading={makeReading()} held />);
    expect(screen.getByText('HOLD')).toBeInTheDocument();
  });
});

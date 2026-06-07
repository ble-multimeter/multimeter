import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', '#000000');
});

describe('useTheme', () => {
  it('toggles the theme and syncs the class, storage and theme-color meta', () => {
    const { result } = renderHook(() => useTheme());
    const before = result.current.theme;

    act(() => result.current.toggle());
    const after = result.current.theme;

    expect(after).not.toBe(before);
    expect(document.documentElement.classList.contains('dark')).toBe(after === 'dark');
    expect(localStorage.getItem('theme')).toBe(after);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      after === 'dark' ? '#09090b' : '#fafafa',
    );
  });

  it('starts from the saved theme', () => {
    localStorage.setItem('theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
  });
});

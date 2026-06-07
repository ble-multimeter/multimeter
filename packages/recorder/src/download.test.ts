// download.ts is DOM-coupled (URL.createObjectURL + a temporary <a> it clicks) but the
// recorder vitest project runs in the node env, so neither URL.createObjectURL nor document
// exist here. We stub them with vi: a fake object-URL factory and a captured anchor element,
// then assert filename/href/blob, the click, and that the object URL is revoked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadText, downloadBlob, slug } from './download';

interface FakeAnchor {
  href: string;
  download: string;
  click: ReturnType<typeof vi.fn>;
}

let anchor: FakeAnchor;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
const FAKE_URL = 'blob:fake-url';

beforeEach(() => {
  anchor = { href: '', download: '', click: vi.fn() };
  createObjectURL = vi.fn(() => FAKE_URL);
  revokeObjectURL = vi.fn();

  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.stubGlobal('document', {
    createElement: vi.fn((tag: string) => {
      expect(tag).toBe('a');
      return anchor as unknown as HTMLAnchorElement;
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadText', () => {
  it('builds a charset-tagged blob, sets href + filename, clicks, then revokes', () => {
    downloadText('a,b,c\n1,2,3', 'data.csv');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/csv;charset=utf-8');

    expect(anchor.href).toBe(FAKE_URL);
    expect(anchor.download).toBe('data.csv');
    expect(anchor.click).toHaveBeenCalledTimes(1);

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(FAKE_URL);
  });

  it('honours a custom MIME type', () => {
    downloadText('{}', 'data.json', 'application/json');
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json;charset=utf-8');
    expect(anchor.download).toBe('data.json');
  });

  it('puts the text into the blob', async () => {
    downloadText('hello world', 'greet.txt', 'text/plain');
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe('hello world');
  });
});

describe('downloadBlob', () => {
  it('downloads a pre-built blob untouched and revokes the url', () => {
    const blob = new Blob(['payload'], { type: 'application/octet-stream' });
    downloadBlob(blob, 'file.bin');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor.href).toBe(FAKE_URL);
    expect(anchor.download).toBe('file.bin');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(FAKE_URL);
  });
});

describe('slug', () => {
  it('replaces runs of unsafe characters with a single dash', () => {
    expect(slug('My Session #1')).toBe('My-Session-1');
  });

  it('keeps safe characters (letters, digits, dot, underscore, dash)', () => {
    expect(slug('a.b_c-1')).toBe('a.b_c-1');
  });

  it('trims leading/trailing dashes produced by the substitution', () => {
    expect(slug('  spaced out  ')).toBe('spaced-out');
    expect(slug('***edge***')).toBe('edge');
  });

  it('falls back to "session" for an empty or whitespace name', () => {
    expect(slug('')).toBe('session');
    expect(slug('   ')).toBe('session');
  });
});

import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { extractZipFiles } from '../src/services/staticAssets';

describe('extractZipFiles', () => {
  it('strips the shared deployment directory and preserves Unicode names and binary contents', () => {
    const zip = new AdmZip();
    const binary = Buffer.from([0, 255, 13, 10, 128]);
    zip.addFile('dist/', Buffer.alloc(0));
    zip.addFile('dist/index.html', Buffer.from('<h1>部署</h1>'));
    zip.addFile('dist/assets/图标.bin', binary);

    const files = new Map(extractZipFiles(zip.toBuffer()).map(file => [file.path, file.buffer]));

    expect([...files.keys()].sort()).toEqual(['assets/图标.bin', 'index.html']);
    expect(files.get('index.html')?.toString()).toBe('<h1>部署</h1>');
    expect(files.get('assets/图标.bin')).toEqual(binary);
  });

  it('preserves paths when the archive contains a root file and multiple directories', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('root'));
    zip.addFile('assets/app.js', Buffer.from('script'));
    zip.addFile('images/logo.svg', Buffer.from('image'));

    expect(extractZipFiles(zip.toBuffer()).map(file => file.path).sort()).toEqual([
      'assets/app.js', 'images/logo.svg', 'index.html',
    ]);
  });

  it('returns no files for an empty archive and rejects a truncated archive', () => {
    const zip = new AdmZip();
    expect(extractZipFiles(zip.toBuffer())).toEqual([]);
    zip.addFile('index.html', Buffer.from('content'));
    expect(() => extractZipFiles(zip.toBuffer().subarray(0, 12))).toThrow();
  });
});

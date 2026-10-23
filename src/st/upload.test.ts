import { afterEach, describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import { uploadOrbImage, withCacheBuster } from './upload';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('悬浮球图标上传', () => {
  it('文件名固定（覆盖同一个文件），返回的路径带版本参数，换图后路径不同、页面会重新加载', async () => {
    vi.spyOn(context, 'getContext').mockReturnValue({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) } as unknown as STContext);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ path: 'user/images/baibai_book/orb.gif' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('FileReader', class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/gif;base64,R0lGOD'; this.onload?.(); }
    });
    const file = new File([new Uint8Array([71, 73, 70])], 'cat.gif', { type: 'image/gif' });
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const first = await uploadOrbImage(file);
    const second = await uploadOrbImage(file);
    expect(first).toBe('user/images/baibai_book/orb.gif?v=1000');
    expect(second).toBe('user/images/baibai_book/orb.gif?v=2000');
    expect(fetchMock.mock.calls.map(c => JSON.parse(c[1]!.body as string).filename)).toEqual(['orb', 'orb']);
  });

  it('已带版本参数的路径会替换成新的版本参数', () => {
    expect(withCacheBuster('/user/images/baibai_book/orb.webp?v=1', 5)).toBe('/user/images/baibai_book/orb.webp?v=5');
    expect(withCacheBuster('/img.webp?size=2', 5)).toBe('/img.webp?size=2&v=5');
  });
});

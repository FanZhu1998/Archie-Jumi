import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS, type Action, type AnimationPack, type Facing } from '../src/shared/types';
import { MAX_ACTIVE_PAGES, alphaHit, closePage, drawablePage, frameKey, loadPack, pageFor, requestPage, validatePack } from '../src/rendering/assets';

const base = './pets/archie/';
const pageUrl = (action: Action) => `${base}actions/${action}.png`;

function manifestFixture(): AnimationPack {
  const animations = Object.fromEntries(ACTIONS.map((action, row) => [action,
    Object.fromEntries((['left', 'right'] as Facing[]).map((facing, direction) => [facing, {
      loop: action !== 'wake',
      frames: [0, 1].map(index => ({ x: (direction * 2 + index) * 16, y: row * 16, w: 16, h: 16, duration: index === 0 ? 100 : 250 })),
    }])),
  ])) as AnimationPack['animations'];
  return {
    formatVersion: 1, id: 'archie', name: 'Archie', atlas: 'atlas.png',
    frameWidth: 16, frameHeight: 16, anchor: { x: 8, y: 15 }, hitShapes: [],
    animations, attribution: 'Synthetic test fixture',
    pages: Object.fromEntries(ACTIONS.map((action, row) => [action, { file: `actions/${action}.png`, offsetX: 0, offsetY: row * 16 }])),
  };
}

interface FakeBitmap { width: number; height: number; close: ReturnType<typeof vi.fn> }

function harness(manifest = manifestFixture()) {
  const dimensions = new Map<string, { width: number; height: number }>();
  const unavailable = new Set<string>();
  const bitmaps = new Map<string, FakeBitmap[]>();
  const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(255);
  const context = {
    clearRect: vi.fn(), drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: rgba })),
  };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
  const fetchMock = vi.fn(async (url: string) => ({
    ok: !unavailable.has(url),
    json: async () => manifest,
    blob: async () => ({ url }) as unknown as Blob,
  }));
  const makeBitmap = (url: string): FakeBitmap => {
    const size = dimensions.get(url) ?? { width: 64, height: url.endsWith('/atlas.png') ? ACTIONS.length * 16 : 16 };
    const image = { ...size, close: vi.fn() };
    bitmaps.set(url, [...(bitmaps.get(url) ?? []), image]);
    return image;
  };
  const decode = vi.fn(async (blob: Blob) => makeBitmap((blob as unknown as { url: string }).url) as unknown as ImageBitmap);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('document', { createElement: vi.fn((tag: string) => {
    if (tag !== 'canvas') throw new Error(`Unexpected element ${tag}`);
    return canvas;
  }) });
  return {
    manifest, dimensions, unavailable, bitmaps, rgba, context, canvas, fetchMock, decode, makeBitmap,
    requests: (url: string) => fetchMock.mock.calls.filter(([requested]) => requested === url).length,
    bitmap: (action: Action) => bitmaps.get(pageUrl(action))![0],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('lazy action-page cache', () => {
  it('keeps idle and the four most recent action pages (a whole play cycle), closes only the evicted bitmap exactly once, and can reload an evicted action', async () => {
    const h = harness(), pack = await loadPack('archie');
    const idle = pageFor(pack, 'idle');
    expect(MAX_ACTIVE_PAGES).toBe(4);
    expect([...pack.cache.keys()]).toEqual(['idle']);
    expect(h.requests(`${base}atlas.png`)).toBe(0);

    // The play cycle (trot, sit, pounce, land) fits, so repeating it fetches no page again (P2-08).
    const cycle: Action[] = ['trot', 'sit', 'pounce', 'land'];
    for (let round = 0; round < 3; round++) for (const action of cycle) await requestPage(pack, action);
    expect([...pack.cache.keys()]).toEqual(['idle', ...cycle]);
    for (const action of cycle) expect(h.requests(pageUrl(action))).toBe(1);
    const trot = pageFor(pack, 'trot'), sit = pageFor(pack, 'sit'), pounce = pageFor(pack, 'pounce');
    expect(trot.image.close).not.toHaveBeenCalled();

    // A fifth action page evicts the least recently requested one (trot) and closes its bitmap.
    await requestPage(pack, 'walk');
    expect([...pack.cache.keys()]).toEqual(['idle', 'sit', 'pounce', 'land', 'walk']);
    expect(trot.image.close).toHaveBeenCalledTimes(1);
    expect(trot.closed).toBe(true);
    expect(sit.closed).toBe(false);
    expect(idle.image.close).not.toHaveBeenCalled();
    expect(pageFor(pack, 'trot')).toBe(idle);
    expect(drawablePage(pack, 'trot')).toBeNull();

    // Requesting a cached page makes it the most recent again, so the next eviction takes pounce instead of sit.
    await requestPage(pack, 'sit');
    expect([...pack.cache.keys()]).toEqual(['idle', 'pounce', 'land', 'walk', 'sit']);
    await requestPage(pack, 'trot');
    expect([...pack.cache.keys()]).toEqual(['idle', 'land', 'walk', 'sit', 'trot']);
    expect(h.requests(pageUrl('trot'))).toBe(2);
    expect(pounce.image.close).toHaveBeenCalledTimes(1);
    expect(sit.image.close).not.toHaveBeenCalled();
    expect(trot.image.close).toHaveBeenCalledTimes(1);
    expect(pageFor(pack, 'trot').image).not.toBe(trot.image);
    expect(pageFor(pack, 'trot').closed).toBe(false);
    expect(pack.cache.size).toBe(1 + MAX_ACTIVE_PAGES);
  });

  it('stays bounded over many action changes and closes every evicted bitmap exactly once', async () => {
    const h = harness(), pack = await loadPack('archie');
    const order: Action[] = ['walk', 'sit', 'groom', 'walk', 'trot', 'pounce', 'land', 'sit', 'trot', 'sleep', 'wake', 'pet', 'eat'];
    for (const action of order) {
      await requestPage(pack, action);
      expect(pack.cache.size).toBeLessThanOrEqual(1 + MAX_ACTIVE_PAGES);
      expect(drawablePage(pack, action)?.clip).toBe(action);
    }
    const cached = new Set([...pack.cache.values()].map(page => page.image));
    for (const images of h.bitmaps.values()) for (const image of images) {
      expect(image.close).toHaveBeenCalledTimes(cached.has(image as unknown as ImageBitmap) ? 0 : 1);
    }
  });

  it('never offers a closed page for drawing, and offers the idle clip after a failed load', async () => {
    const h = harness(), pack = await loadPack('archie');
    expect(drawablePage(pack, 'walk')).toBeNull();
    await requestPage(pack, 'walk');
    const walk = pageFor(pack, 'walk');
    expect(drawablePage(pack, 'walk')).toEqual({ page: walk, clip: 'walk' });
    h.unavailable.add(pageUrl('eat'));
    await expect(requestPage(pack, 'eat')).rejects.toThrow('Could not load character animation');
    expect(drawablePage(pack, 'eat')).toEqual({ page: pageFor(pack, 'idle'), clip: 'idle' });
    closePage(walk); closePage(walk);
    expect(walk.image.close).toHaveBeenCalledTimes(1);
    expect(walk.closed).toBe(true);
    expect(drawablePage(pack, 'walk')).toBeNull();
  });

  it('deduplicates in-flight requests and stays bounded when requests complete out of order', async () => {
    const h = harness(), pack = await loadPack('archie');
    // Three pages already cached, so the two out-of-order loads below push the cache one past its bound.
    for (const action of ['sit', 'groom', 'sleep'] as Action[]) await requestPage(pack, action);
    const sit = pageFor(pack, 'sit');
    const walkDecode = deferred<ImageBitmap>(), trotDecode = deferred<ImageBitmap>();
    h.decode.mockImplementation(async blob => {
      const url = (blob as unknown as { url: string }).url;
      if (url === pageUrl('walk')) return walkDecode.promise;
      if (url === pageUrl('trot')) return trotDecode.promise;
      return h.makeBitmap(url) as unknown as ImageBitmap;
    });
    const walkRequest = requestPage(pack, 'walk');
    const duplicateWalkRequest = requestPage(pack, 'walk');
    const trotRequest = requestPage(pack, 'trot');
    expect(pack.pending.size).toBe(2);
    await requestPage(pack, 'pet');
    expect(h.requests(pageUrl('pet'))).toBe(0);
    expect(h.requests(pageUrl('walk'))).toBe(1);

    const trot = h.makeBitmap(pageUrl('trot'));
    trotDecode.resolve(trot as unknown as ImageBitmap);
    await trotRequest;
    expect([...pack.cache.keys()]).toEqual(['idle', 'sit', 'groom', 'sleep', 'trot']);
    expect(pack.pending.has('walk')).toBe(true);

    const walk = h.makeBitmap(pageUrl('walk'));
    walkDecode.resolve(walk as unknown as ImageBitmap);
    await Promise.all([walkRequest, duplicateWalkRequest]);
    expect([...pack.cache.keys()]).toEqual(['idle', 'groom', 'sleep', 'trot', 'walk']);
    expect(sit.image.close).toHaveBeenCalledTimes(1);
    expect(trot.close).not.toHaveBeenCalled();
    expect(walk.close).not.toHaveBeenCalled();
    expect(pack.pending.size).toBe(0);
    expect(h.bitmap('idle').close).not.toHaveBeenCalled();
  });

  it('subtracts page offsets for mask extraction and excludes transparent or low-alpha pixels', async () => {
    const h = harness(), pack = await loadPack('archie');
    h.rgba[3] = 100;
    h.rgba[7] = 101;
    h.context.drawImage.mockClear();
    await requestPage(pack, 'sleep');
    const page = pageFor(pack, 'sleep'), frame = pack.manifest.animations.sleep.right.frames[0];
    expect(page.offsetY).toBe(ACTIONS.indexOf('sleep') * 16);
    expect(h.context.drawImage).toHaveBeenCalledWith(page.image, frame.x, 0, 16, 16, 0, 0, 64, 64);
    expect(page.masks.has(frameKey(frame))).toBe(true);
    expect(alphaHit(page, frame, 0, 0)).toBe(false);
    expect(alphaHit(page, frame, 1 / 64, 0)).toBe(true);
  });

  it('rejects out-of-bounds image pages without replacing good cached pages, and suppresses retry loops', async () => {
    const h = harness(), pack = await loadPack('archie');
    await requestPage(pack, 'pet');
    const idle = pageFor(pack, 'idle'), pet = pageFor(pack, 'pet');
    h.dimensions.set(pageUrl('walk'), { width: 63, height: 16 });
    await expect(requestPage(pack, 'walk')).rejects.toThrow('outside its image page');
    expect(h.bitmap('walk').close).toHaveBeenCalledTimes(1);
    expect([...pack.cache.keys()]).toEqual(['idle', 'pet']);
    expect(pageFor(pack, 'idle')).toBe(idle);
    expect(pageFor(pack, 'pet')).toBe(pet);
    expect(idle.image.close).not.toHaveBeenCalled();
    expect(pet.image.close).not.toHaveBeenCalled();
    expect(pack.failed.has('walk')).toBe(true);
    expect(pack.pending.has('walk')).toBe(false);

    for (let frame = 0; frame < 90; frame++) await requestPage(pack, 'walk');
    expect(h.requests(pageUrl('walk'))).toBe(1);
    expect(h.bitmap('walk').close).toHaveBeenCalledTimes(1);
  });

  it('suppresses network-failure retries without decoding or evicting a usable page', async () => {
    const h = harness(), pack = await loadPack('archie');
    const idle = pageFor(pack, 'idle');
    h.unavailable.add(pageUrl('eat'));
    await expect(requestPage(pack, 'eat')).rejects.toThrow('Could not load character animation');
    await Promise.all(Array.from({ length: 60 }, () => requestPage(pack, 'eat')));
    expect(h.requests(pageUrl('eat'))).toBe(1);
    expect(h.decode).toHaveBeenCalledTimes(1);
    expect(pageFor(pack, 'eat')).toBe(idle);
    expect(pack.pending.size).toBe(0);
    expect(idle.image.close).not.toHaveBeenCalled();
  });

  it('closes a bitmap rejected by the decoded-image budget before creating masks', async () => {
    const h = harness(), pack = await loadPack('archie');
    h.dimensions.set(pageUrl('pounce'), { width: 6000, height: 6000 });
    h.context.drawImage.mockClear();
    await expect(requestPage(pack, 'pounce')).rejects.toThrow('decoded image budget');
    expect(h.bitmap('pounce').close).toHaveBeenCalledTimes(1);
    expect(h.context.drawImage).not.toHaveBeenCalled();
    expect([...pack.cache.keys()]).toEqual(['idle']);
  });

  it('closes a decoded bitmap when canvas mask extraction fails and preserves the good page', async () => {
    const h = harness(), pack = await loadPack('archie');
    const idle = pageFor(pack, 'idle');
    h.context.getImageData.mockImplementationOnce(() => { throw new Error('Canvas readback failed'); });
    await expect(requestPage(pack, 'groom')).rejects.toThrow('Canvas readback failed');
    expect(h.bitmap('groom').close).toHaveBeenCalledTimes(1);
    expect([...pack.cache.keys()]).toEqual(['idle']);
    expect(pageFor(pack, 'groom')).toBe(idle);
    expect(idle.image.close).not.toHaveBeenCalled();
    expect(pack.failed.has('groom')).toBe(true);
    await requestPage(pack, 'groom');
    expect(h.requests(pageUrl('groom'))).toBe(1);
  });

  it('uses one shared full atlas and all its masks for packs without action pages', async () => {
    const manifest = manifestFixture(); delete manifest.pages;
    const h = harness(manifest), pack = await loadPack('archie');
    const fullAtlas = pageFor(pack, 'idle');
    for (const action of ACTIONS) {
      await requestPage(pack, action);
      expect(pageFor(pack, action)).toBe(fullAtlas);
      expect(drawablePage(pack, action)).toEqual({ page: fullAtlas, clip: action });
      expect(fullAtlas.masks.has(frameKey(manifest.animations[action].right.frames[0]))).toBe(true);
    }
    expect(fullAtlas.offsetX).toBe(0);
    expect(fullAtlas.offsetY).toBe(0);
    expect(h.requests(`${base}atlas.png`)).toBe(1);
    expect(h.decode).toHaveBeenCalledTimes(1);
    expect(pack.cache.size).toBe(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid frame duration %s before image requests', async duration => {
    const manifest = manifestFixture();
    manifest.animations.walk.right.frames[0].duration = duration;
    const h = harness(manifest);
    expect(() => validatePack(manifest, 'archie')).toThrow('Invalid frame');
    await expect(loadPack('archie')).rejects.toThrow('Invalid frame');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.decode).not.toHaveBeenCalled();
  });
});

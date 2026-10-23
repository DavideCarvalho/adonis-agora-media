// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loaderWidths,
  MediaImage,
  type MediaImageData,
  mediaImageLoader,
  placeholderStyle,
} from './media-image.js';

const image: MediaImageData = {
  src: 'https://cdn.test/banner.png',
  srcSet: 'https://cdn.test/sm.webp 320w, https://cdn.test/banner.png 1000w',
  width: 1000,
  height: 500,
  placeholder: { dataUrl: 'data:image/webp;base64,AAAA', color: '#1478c8' },
};

/** By attribute, not role: `alt=""` rightly makes the image `presentation`. */
function img() {
  return document.querySelector('img[data-media-image]') as HTMLImageElement;
}

/** The SVG inside `background-image: url("data:image/svg+xml;charset=utf-8,…")`, decoded. */
function decodedSvg(backgroundImage: string) {
  const match = /^url\("data:image\/svg\+xml;charset=utf-8,(.*)"\)$/.exec(backgroundImage);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

afterEach(() => vi.restoreAllMocks());

describe('<MediaImage>', () => {
  it('renders one <img> with srcset, sizes, intrinsic size and lazy loading', () => {
    render(<MediaImage image={image} alt="Banner" sizes="100vw" className="hero" />);
    const el = img();
    expect(screen.getByRole('img', { name: 'Banner' })).toBe(el);
    expect(el.getAttribute('src')).toBe(image.src);
    expect(el.getAttribute('srcset')).toBe(image.srcSet);
    expect(el.getAttribute('sizes')).toBe('100vw');
    expect(el.getAttribute('width')).toBe('1000');
    expect(el.getAttribute('height')).toBe('500');
    expect(el.getAttribute('alt')).toBe('Banner');
    expect(el.getAttribute('loading')).toBe('lazy');
    expect(el.getAttribute('decoding')).toBe('async');
    expect(el.getAttribute('fetchpriority')).toBeNull();
    expect(el.className).toBe('hero');
  });

  it('paints the blurred preview over the dominant colour until the image loads', () => {
    const onLoad = vi.fn();
    render(<MediaImage image={image} alt="" onLoad={onLoad} />);
    const el = img();

    expect(el.style.backgroundColor).toBe('rgb(20, 120, 200)');
    expect(el.style.backgroundSize).toBe('cover');
    expect(el.style.color).toBe('transparent');
    const svg = decodedSvg(el.style.backgroundImage);
    expect(svg).toContain("href='data:image/webp;base64,AAAA'");
    expect(svg).toContain('feGaussianBlur');
    expect(svg).toContain('filter: url(#b)');
    // the intrinsic size fixes the blur's proportions: long edge 640
    expect(svg).toContain("viewBox='0 0 640 320'");

    fireEvent.load(el);

    expect(el.style.backgroundImage).toBe('');
    expect(el.style.backgroundColor).toBe('');
    expect(el.style.color).toBe('');
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('keeps the preview when the image fails to load', () => {
    render(<MediaImage image={image} alt="" />);
    fireEvent.error(img());
    expect(img().style.backgroundImage).not.toBe('');
  });

  it('drops the preview at once for an image that loaded before hydration', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1000);
    render(<MediaImage image={image} alt="" />);
    expect(img().style.backgroundImage).toBe('');
  });

  it('priority: eager, high fetch priority', () => {
    render(<MediaImage image={image} alt="" priority loading="lazy" />);
    expect(img().getAttribute('loading')).toBe('eager');
    expect(img().getAttribute('fetchpriority')).toBe('high');
  });

  it('fill: covers the positioned parent, no size attributes, preview follows objectFit', () => {
    render(<MediaImage image={image} alt="" fill style={{ objectFit: 'contain' }} />);
    const el = img();
    expect(el.getAttribute('width')).toBeNull();
    expect(el.getAttribute('height')).toBeNull();
    expect(el.style.position).toBe('absolute');
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('100%');
    expect(el.style.objectFit).toBe('contain');
    expect(el.style.backgroundSize).toBe('contain');
  });

  it("placeholder='color' paints only the dominant colour; 'empty' paints nothing", () => {
    const { unmount } = render(<MediaImage image={image} alt="" placeholder="color" />);
    expect(img().style.backgroundColor).toBe('rgb(20, 120, 200)');
    expect(img().style.backgroundImage).toBe('');
    unmount();

    render(<MediaImage image={image} alt="" placeholder="empty" />);
    expect(img().style.backgroundColor).toBe('');
    expect(img().style.color).toBe('');
  });

  it('works with a bare descriptor: no preview, no srcset, so no sizes either', () => {
    render(<MediaImage image={{ src: '/a.png' }} alt="" sizes="50vw" />);
    const el = img();
    expect(el.getAttribute('srcset')).toBeNull();
    expect(el.getAttribute('sizes')).toBeNull();
    expect(el.getAttribute('width')).toBeNull();
    expect(el.style.backgroundImage).toBe('');
  });

  it('width/height override the intrinsic size; refs reach the <img>', () => {
    const ref = createRef<HTMLImageElement>();
    render(<MediaImage ref={ref} image={image} alt="" width={200} height={100} />);
    expect(img().getAttribute('width')).toBe('200');
    expect(img().getAttribute('height')).toBe('100');
    expect(ref.current).toBe(img());
  });

  it('style from the caller wins', () => {
    render(<MediaImage image={image} alt="" style={{ backgroundColor: 'red' }} />);
    expect(img().style.backgroundColor).toBe('red');
  });
});

describe('<MediaImage src>', () => {
  it('renders a plain URL like <img src>, with your own srcSet and size', () => {
    render(
      <MediaImage
        src="/hero.jpg"
        srcSet="/hero-640.jpg 640w, /hero.jpg 1600w"
        sizes="100vw"
        width={1600}
        height={900}
        alt="Hero"
      />,
    );
    const el = img();
    expect(el.getAttribute('src')).toBe('/hero.jpg');
    expect(el.getAttribute('srcset')).toBe('/hero-640.jpg 640w, /hero.jpg 1600w');
    expect(el.getAttribute('sizes')).toBe('100vw');
    expect(el.getAttribute('width')).toBe('1600');
    expect(el.getAttribute('loading')).toBe('lazy');
    expect(el.style.backgroundImage).toBe('');
  });

  it('blurDataURL paints the preview (next/image naming); placeholderColor goes under it', () => {
    render(
      <MediaImage
        src="/hero.jpg"
        width={1600}
        height={900}
        blurDataURL="data:image/webp;base64,AAAA"
        placeholderColor="#1478c8"
        alt=""
      />,
    );
    const el = img();
    expect(el.style.backgroundColor).toBe('rgb(20, 120, 200)');
    expect(decodedSvg(el.style.backgroundImage)).toContain("viewBox='0 0 640 360'");
    fireEvent.load(el);
    expect(el.style.backgroundImage).toBe('');
  });

  it('a colour alone defaults to placeholder="color"', () => {
    render(<MediaImage src="/a.jpg" placeholderColor="#1478c8" alt="" />);
    expect(img().style.backgroundColor).toBe('rgb(20, 120, 200)');
    expect(img().style.backgroundImage).toBe('');
  });
});

describe('<MediaImage src loader>', () => {
  const loader = mediaImageLoader();

  it('fixed size (width, no sizes): 1x and 2x, rounded up to allowed widths', () => {
    render(
      <MediaImage src="m1" loader={loader} width={800} height={400} sizes={undefined} alt="" />,
    );
    const el = img();
    expect(el.getAttribute('srcset')).toBe('/media/m1?w=828 1x, /media/m1?w=1920 2x');
    expect(el.getAttribute('src')).toBe('/media/m1?w=1920');
    expect(el.getAttribute('sizes')).toBeNull();
    expect(el.getAttribute('width')).toBe('800');
  });

  it('responsive (sizes): w descriptors, skipping widths the smallest vw never needs', () => {
    render(<MediaImage src="m1" loader={loader} quality={75} sizes="50vw" alt="" />);
    const el = img();
    const widths = el
      .getAttribute('srcset')!
      .split(', ')
      .map((c) => c.split(' ')[1]);
    expect(widths).toEqual([
      '384w',
      '640w',
      '750w',
      '828w',
      '1080w',
      '1200w',
      '1920w',
      '2048w',
      '3840w',
    ]);
    expect(el.getAttribute('srcset')).toContain('/media/m1?w=384&q=75 384w');
    expect(el.getAttribute('sizes')).toBe('50vw');
  });

  it('fill: every device width', () => {
    render(<MediaImage src="m1" loader={loader} fill alt="" />);
    expect(img().getAttribute('srcset')!.split(', ')).toHaveLength(8);
  });

  it('custom deviceSizes/imageSizes (must match the server whitelist)', () => {
    render(
      <MediaImage
        src="m1"
        loader={loader}
        width={100}
        deviceSizes={[200]}
        imageSizes={[100]}
        alt=""
      />,
    );
    expect(img().getAttribute('srcset')).toBe('/media/m1?w=100 1x, /media/m1?w=200 2x');
  });
});

describe('<MediaImage layout> and sizes', () => {
  it('constrained: sizes up to its width, prefixed with auto when lazy; box capped at the width', () => {
    render(<MediaImage image={image} alt="" layout="constrained" />);
    const el = img();
    expect(el.getAttribute('sizes')).toBe('auto, (min-width: 1000px) 1000px, 100vw');
    expect(el.style.maxWidth).toBe('1000px');
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('auto');
  });

  it('priority images are not lazy, so no auto', () => {
    render(<MediaImage image={image} alt="" layout="constrained" priority />);
    expect(img().getAttribute('sizes')).toBe('(min-width: 1000px) 1000px, 100vw');
  });

  it('fullWidth: 100vw and a full-width box', () => {
    render(<MediaImage image={image} alt="" layout="fullWidth" />);
    expect(img().getAttribute('sizes')).toBe('auto, 100vw');
    expect(img().style.width).toBe('100%');
  });

  it('fixed with a loader: 1x/2x at that size, no sizes, a fixed box', () => {
    render(
      <MediaImage
        src="m1"
        loader={mediaImageLoader()}
        layout="fixed"
        width={400}
        height={200}
        alt=""
      />,
    );
    const el = img();
    expect(el.getAttribute('srcset')).toBe('/media/m1?w=640 1x, /media/m1?w=828 2x');
    expect(el.getAttribute('sizes')).toBeNull();
    expect(el.style.width).toBe('400px');
    expect(el.style.height).toBe('200px');
  });

  it('constrained with a loader: the w list that sizes implies', () => {
    render(
      <MediaImage src="m1" loader={mediaImageLoader()} layout="constrained" width={800} alt="" />,
    );
    expect(img().getAttribute('sizes')).toBe('auto, (min-width: 800px) 800px, 100vw');
    expect(img().getAttribute('srcset')).toContain('/media/m1?w=640 640w');
  });

  it('an explicit sizes always wins, untouched', () => {
    render(<MediaImage image={image} alt="" layout="constrained" sizes="50vw" />);
    expect(img().getAttribute('sizes')).toBe('50vw');
  });

  it('no layout, no sizes: lazy gets "auto, 100vw", eager leaves it to the browser', () => {
    const { unmount } = render(<MediaImage image={image} alt="" />);
    expect(img().getAttribute('sizes')).toBe('auto, 100vw');
    unmount();
    render(<MediaImage image={image} alt="" loading="eager" />);
    expect(img().getAttribute('sizes')).toBeNull();
  });
});

describe('mediaImageLoader / loaderWidths', () => {
  it('maps src through `path`, keeping an existing query string, and encodes the default path', () => {
    expect(mediaImageLoader()({ src: 'a b', width: 640 })).toBe('/media/a%20b?w=640');
    const signed = mediaImageLoader({ path: (id) => `/files/${id}?token=t` });
    expect(signed({ src: 'x', width: 640, quality: 75 })).toBe('/files/x?token=t&w=640&q=75');
  });

  it('sizes without vw keeps every width; a width past the largest caps at it', () => {
    expect(
      loaderWidths(undefined, '(max-width: 600px) 480px, 800px', [640, 1080], [256]).widths,
    ).toEqual([256, 640, 1080]);
    expect(loaderWidths(5000, undefined, [640, 1080], [256])).toEqual({
      widths: [1080],
      kind: 'x',
    });
  });
});

describe('<MediaImage> on the server', () => {
  it('ships the preview in the markup, before any JavaScript runs', () => {
    const html = renderToString(<MediaImage image={image} alt="Banner" priority />);
    expect(html).toContain('background-image:url(&quot;data:image/svg+xml');
    expect(html).toContain('background-color:#1478c8');
    expect(html).toContain('loading="eager"');
    // React 19 hoists a preload for a high-priority image — next/image's `priority`, for free
    expect(html).toMatch(
      /<link rel="preload" as="image"[^>]*imageSrcSet="https:\/\/cdn\.test\/sm\.webp 320w/,
    );
  });
});

describe('placeholderStyle', () => {
  it('without a size crops the preview like object-fit', () => {
    const style = placeholderStyle(image.placeholder!);
    expect(style.backgroundColor).toBe('#1478c8');
    expect(style.backgroundSize).toBe('cover');
    const svg = decodeURIComponent(
      String(style.backgroundImage)
        .replace(/^url\("data:image\/svg\+xml;charset=utf-8,/, '')
        .replace(/"\)$/, ''),
    );
    expect(svg).not.toContain('viewBox');
    expect(svg).toContain("preserveAspectRatio='xMidYMid slice'");
    expect(svg).toContain("width='100%'");
  });
});

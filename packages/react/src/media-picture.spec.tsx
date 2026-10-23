// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MediaImageData } from './media-image.js';
import { MediaPicture } from './media-picture.js';

const wide: MediaImageData = {
  src: '/wide-1000.jpg',
  srcSet: '/wide-640.webp 640w, /wide-1000.jpg 1000w',
  width: 1000,
  height: 500,
  placeholder: { dataUrl: 'data:image/webp;base64,AAAA', color: '#1478c8' },
};
const square: MediaImageData = {
  src: '/sq-400.webp',
  srcSet: '/sq-200.webp 200w, /sq-400.webp 400w',
  width: 400,
  height: 400,
};

describe('<MediaPicture>', () => {
  it('renders the sources in order, each with its own size, then the MediaImage fallback', () => {
    const { container } = render(
      <MediaPicture
        image={wide}
        alt="Course"
        sizes="100vw"
        sources={[
          { media: '(max-width: 640px)', image: square },
          { type: 'image/avif', image: { src: '/wide.avif' } },
        ]}
      />,
    );
    const picture = container.querySelector('picture')!;
    const [phone, avif] = [...picture.querySelectorAll('source')];
    expect(phone!.getAttribute('media')).toBe('(max-width: 640px)');
    expect(phone!.getAttribute('srcset')).toBe(square.srcSet);
    expect(phone!.getAttribute('sizes')).toBe('100vw');
    expect([phone!.getAttribute('width'), phone!.getAttribute('height')]).toEqual(['400', '400']);
    expect(avif!.getAttribute('type')).toBe('image/avif');
    expect(avif!.getAttribute('srcset')).toBe('/wide.avif');
    expect(avif!.getAttribute('sizes')).toBeNull();

    const img = picture.querySelector('img')!;
    expect(img.getAttribute('srcset')).toBe(wide.srcSet);
    expect(img.getAttribute('alt')).toBe('Course');
    expect(img.style.backgroundImage).toContain('data:image/svg+xml');
  });

  it('lazy sources without sizes get "auto, 100vw"; per-source sizes win', () => {
    const { container } = render(
      <MediaPicture
        image={wide}
        alt=""
        sources={[
          { media: '(max-width: 640px)', image: square },
          { media: '(max-width: 900px)', image: square, sizes: '50vw' },
        ]}
      />,
    );
    const [first, second] = [...container.querySelectorAll('source')];
    expect(first!.getAttribute('sizes')).toBe('auto, 100vw');
    expect(second!.getAttribute('sizes')).toBe('50vw');
  });

  it('server-renders the whole picture', () => {
    const html = renderToString(
      <MediaPicture
        image={wide}
        alt=""
        sources={[{ media: '(max-width: 640px)', image: square }]}
      />,
    );
    expect(html).toMatch(
      /^<picture><source media="\(max-width: 640px\)" srcSet="\/sq-200\.webp 200w/,
    );
    expect(html).toContain('<img');
  });
});

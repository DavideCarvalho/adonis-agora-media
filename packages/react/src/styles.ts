/**
 * Minimal, opt-in default styling for {@link MediaUploader}, themed to Agora design tokens.
 *
 * Everything is expressed through CSS custom properties that *fall back* to the Agora token set
 * (`--agora-primary`, `--agora-primary-soft`, `--agora-ink`) when the surrounding app defines them,
 * and to neutral literals otherwise. There is no NestJS/vendor branding. Consumers override any
 * `--agora-media-*` variable, restyle via the `[data-media-uploader]` attribute, or pass their own
 * `className` / `render` and skip these styles entirely.
 */
export const MEDIA_UPLOADER_STYLE_ID = 'agora-media-uploader-styles';

export const mediaUploaderCss = `
[data-media-uploader] {
  --agora-media-accent: var(--agora-primary, #5a45ff);
  --agora-media-accent-soft: var(--agora-primary-soft, rgba(90, 69, 255, 0.14));
  --agora-media-ink: var(--agora-ink, #12121a);
  --agora-media-track: var(--color-fd-muted, rgba(90, 69, 255, 0.1));
  --agora-media-radius: 8px;

  display: inline-flex;
  flex-direction: column;
  gap: 0.5rem;
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  color: var(--color-fd-foreground, var(--agora-media-ink));
}

[data-media-uploader] input[type="file"] {
  font: inherit;
  color: inherit;
}

[data-media-uploader] input[type="file"]::file-selector-button {
  margin-right: 0.75rem;
  padding: 0.4rem 0.9rem;
  border: 0;
  border-radius: var(--agora-media-radius);
  background: var(--agora-media-accent-soft);
  color: var(--agora-media-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 120ms ease;
}

[data-media-uploader] input[type="file"]::file-selector-button:hover {
  background: var(--agora-media-accent);
  color: #fff;
}

[data-media-uploader] progress {
  width: 100%;
  min-width: 12rem;
  height: 0.5rem;
  border: 0;
  border-radius: 999px;
  overflow: hidden;
  background: var(--agora-media-track);
  accent-color: var(--agora-media-accent);
}

[data-media-uploader] progress::-webkit-progress-bar {
  background: var(--agora-media-track);
  border-radius: 999px;
}

[data-media-uploader] progress::-webkit-progress-value {
  background: var(--agora-media-accent);
  border-radius: 999px;
  transition: width 120ms ease;
}

[data-media-uploader] progress::-moz-progress-bar {
  background: var(--agora-media-accent);
  border-radius: 999px;
}

[data-media-uploader][data-status="error"] progress {
  accent-color: var(--color-fd-primary, #e5484d);
}

[data-media-uploader] [data-media-status] {
  font-size: 0.8125rem;
  color: var(--color-fd-muted-foreground, #6b7280);
}
`;

/** Inject the default stylesheet once per document (no-op on the server / when already present). */
export function ensureMediaUploaderStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MEDIA_UPLOADER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MEDIA_UPLOADER_STYLE_ID;
  style.textContent = mediaUploaderCss;
  document.head.appendChild(style);
}

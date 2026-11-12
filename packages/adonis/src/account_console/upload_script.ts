/**
 * The account console's upload component: a same-origin script authkit loads (with the page's CSP
 * nonce) for a `component` block of provider `media-upload`. It adds a file picker to the mount
 * point, sends the file to the media upload endpoint with the block's ticket, then submits the
 * block's form with the new file's id (`field_media`) so authkit runs the `upload` action and shows
 * its message. Without JavaScript the block's fallback text stays.
 */
export const UPLOAD_SCRIPT = `(() => {
  'use strict';
  const mounts = document.querySelectorAll('[data-block="component"][data-provider="media-upload"]');
  for (const mount of mounts) {
    if (mount.getAttribute('data-mounted') === '1') continue;
    mount.setAttribute('data-mounted', '1');
    let props;
    try {
      props = JSON.parse(document.getElementById(mount.getAttribute('data-props')).textContent);
    } catch (e) {
      continue;
    }
    const labels = props.labels || {};
    const form = mount.querySelector('form[data-component-form]');
    const fallback = mount.querySelector('[data-component-fallback]');
    if (fallback) fallback.hidden = true;
    const row = document.createElement('div');
    row.className = 'flex flex-wrap items-center gap-2';
    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'text-sm text-gray-700';
    input.setAttribute('aria-label', labels.choose || 'File');
    if (props.accept) input.accept = props.accept;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white';
    button.textContent = labels.upload || 'Upload';
    const status = document.createElement('p');
    status.className = 'mt-2 text-sm text-gray-500';
    status.setAttribute('role', 'status');
    row.appendChild(input);
    row.appendChild(button);
    mount.appendChild(row);
    mount.appendChild(status);
    button.addEventListener('click', async () => {
      const file = input.files && input.files[0];
      if (!file) {
        status.textContent = labels.pick || 'Choose a file first.';
        return;
      }
      if (props.maxBytes && file.size > props.maxBytes) {
        status.textContent = labels.tooLarge || 'This file is too large.';
        return;
      }
      button.disabled = true;
      status.textContent = labels.uploading || 'Uploading…';
      const headers = {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        'x-media-upload-ticket': props.ticket,
        accept: 'application/json',
      };
      const csrf = form && form.querySelector('input[name="_csrf"]');
      if (csrf && props.sameOrigin) headers['x-csrf-token'] = csrf.value;
      try {
        const res = await fetch(props.endpoint, {
          method: 'POST',
          headers,
          body: file,
          credentials: props.sameOrigin ? 'same-origin' : 'omit',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.id) throw new Error(body.error || labels.failed || 'Upload failed.');
        if (!form) {
          window.location.reload();
          return;
        }
        const field = document.createElement('input');
        field.type = 'hidden';
        field.name = 'field_media';
        field.value = body.id;
        form.appendChild(field);
        form.submit();
      } catch (error) {
        button.disabled = false;
        status.textContent = error && error.message ? error.message : labels.failed || 'Upload failed.';
      }
    });
  }
})();
`;

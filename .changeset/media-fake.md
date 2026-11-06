---
'@adonis-agora/media': minor
---

**`media.fake()` / `media.restore()`** — fake the media service in app tests, like `drive.fake()` and `mail.fake()`.

`import media from '@adonis-agora/media/services/main'` captures the `MediaManager` once at boot, so `app.container.swap(MediaManager, …)` never reaches code that already imported it, and apps fell back to monkeypatching `media.library.attach = …`, which leaks between suites. The swap now happens inside the manager:

```ts
const fake = media.fake()
await uploadAvatar()
fake.assertCalled('attach', (input) => input.collection === 'avatar')
assert.equal(fake.calls.signedUrl[0]?.[1], 300) // TTL
fake.stub('deliver', async () => ({ kind: 'redirect', url: 'https://cdn.test/x' }))
media.restore()
```

- While faked, `media.library` (and `store`, `storage`, `attachments`, `uploads`, `resumable`, `direct`) run the real library code, with the configured collections and delivery settings, over an `InMemoryMediaStore`, an `InMemoryDisk` for every disk name and a `FakeImageProcessor`.
- The returned `MediaFake` records every `media.library` call with typed arguments (`fake.calls.<method>`), has `assertCalled` / `assertNotCalled`, and `stub(method, fn)` / `unstub(method)` to force a result or an error.
- `media.fake()` again starts a fresh fake; `media.restore()` is a no-op without one.
- New exports from `@adonis-agora/media/testing`: `MediaFake`, `MEDIA_FAKE_METHODS`, `lazyInMemoryDiskResolver`, and the types `MediaFakeOptions`, `MediaFakeMethod`, `MediaFakeCall`, `MediaFakeCalls`, `MediaFakeStub`.

`MediaManager.storage`, `library`, `attachments`, `store` and `uploads` are now getters instead of readonly fields. Reading them is unchanged; nothing could assign them before (they were `readonly`).

import type { Readable } from 'node:stream';
import type { MediaRecord } from '../src/media_record.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import type { DiskWriteOptions } from '../src/types.js';

/** An {@link InMemoryDisk} that logs every body read and write as `<method> <key>`. */
export class CountingDisk extends InMemoryDisk {
  readonly log: string[] = [];

  count(method: string, key?: string): number {
    return this.log.filter((entry) =>
      key === undefined ? entry.startsWith(`${method} `) : entry === `${method} ${key}`,
    ).length;
  }

  override async put(key: string, contents: Uint8Array, options?: DiskWriteOptions) {
    this.log.push(`put ${key}`);
    return super.put(key, contents, options);
  }

  override async putStream(key: string, contents: Readable, options?: DiskWriteOptions) {
    this.log.push(`putStream ${key}`);
    return super.putStream(key, contents, options);
  }

  override async getBytes(key: string) {
    this.log.push(`getBytes ${key}`);
    return super.getBytes(key);
  }

  override async getStream(key: string) {
    this.log.push(`getStream ${key}`);
    return super.getStream(key);
  }

  override async getUrl(key: string) {
    this.log.push(`getUrl ${key}`);
    return super.getUrl(key);
  }
}

/** An {@link InMemoryMediaStore} that counts calls per method. */
export class CountingStore extends InMemoryMediaStore {
  readonly calls = { find: 0, save: 0 };

  override async find(id: string): Promise<MediaRecord | null> {
    this.calls.find += 1;
    return super.find(id);
  }

  override async save(record: MediaRecord): Promise<MediaRecord> {
    this.calls.save += 1;
    return super.save(record);
  }

  reset(): void {
    this.calls.find = 0;
    this.calls.save = 0;
  }
}

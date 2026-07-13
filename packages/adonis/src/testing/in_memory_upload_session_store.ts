import type {
  UploadSession,
  UploadSessionListFilter,
  UploadSessionStore,
} from '../resumable_upload.js';
import type { MultipartPart } from '../types.js';

/**
 * In-memory {@link UploadSessionStore} for tests and single-process scratch apps. Non-durable —
 * sessions vanish on restart. Returns defensive copies so mutating a result never mutates the store.
 */
export class InMemoryUploadSessionStore implements UploadSessionStore {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly parts = new Map<string, Map<number, string>>();

  async create(session: UploadSession): Promise<UploadSession> {
    const stored: UploadSession = { ...session, createdAt: session.createdAt ?? new Date() };
    this.sessions.set(stored.id, { ...stored });
    return { ...stored };
  }

  async get(id: string): Promise<UploadSession | null> {
    const found = this.sessions.get(id);
    return found ? { ...found } : null;
  }

  async update(session: UploadSession): Promise<UploadSession> {
    this.sessions.set(session.id, { ...session });
    return { ...session };
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    this.parts.delete(id);
  }

  async addPart(id: string, part: MultipartPart): Promise<void> {
    const existing = this.parts.get(id) ?? new Map<number, string>();
    existing.set(part.partNumber, part.etag);
    this.parts.set(id, existing);
  }

  async listParts(id: string): Promise<MultipartPart[]> {
    return [...(this.parts.get(id) ?? new Map<number, string>()).entries()].map(
      ([partNumber, etag]) => ({ partNumber, etag }),
    );
  }

  async list(filter: UploadSessionListFilter = {}): Promise<UploadSession[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          (filter.disk === undefined || session.disk === filter.disk) &&
          (filter.keyPrefix === undefined || session.key.startsWith(filter.keyPrefix)),
      )
      .map((session) => ({ ...session }));
  }
}

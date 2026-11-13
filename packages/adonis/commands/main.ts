import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import { MediaDisksList } from './console_disks.js';
import {
  MediaFoldersCreate,
  MediaObjectsCopy,
  MediaObjectsDelete,
  MediaObjectsList,
  MediaObjectsMove,
  MediaObjectsRename,
  MediaObjectsShow,
  MediaObjectsUpload,
} from './console_objects.js';
import {
  MediaCollectionsList,
  MediaRecordsDelete,
  MediaRecordsList,
  MediaRecordsShow,
} from './console_records.js';
import { MediaUploadsAbort, MediaUploadsList, MediaUploadsShow } from './console_uploads.js';
import MediaDoctor from './media_doctor.js';
import MediaPublishMigration from './publish_migration.js';
import MediaTenancyBackfill from './tenancy_backfill.js';

/**
 * The commands barrel for `@adonis-agora/media`: `agora:doctor`, `media:doctor`,
 * `media:publish-migration`, `media:tenancy:backfill` and the console commands (`media:disks:*`,
 * `media:objects:*`, `media:folders:*`, `media:collections:*`, `media:records:*`,
 * `media:uploads:*`). Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/media/commands')`, which this package's `configure` does.
 */
const loader = new ListLoader([
  AgoraDoctor,
  MediaDoctor,
  MediaPublishMigration,
  MediaTenancyBackfill,
  MediaDisksList,
  MediaObjectsList,
  MediaObjectsShow,
  MediaObjectsUpload,
  MediaObjectsCopy,
  MediaObjectsMove,
  MediaObjectsRename,
  MediaObjectsDelete,
  MediaFoldersCreate,
  MediaCollectionsList,
  MediaRecordsList,
  MediaRecordsShow,
  MediaRecordsDelete,
  MediaUploadsList,
  MediaUploadsShow,
  MediaUploadsAbort,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

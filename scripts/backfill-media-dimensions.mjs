#!/usr/bin/env node
/**
 * Backfill `metadata.width` / `metadata.height` on existing video & reel posts.
 *
 * Newer posts store the media dimensions at upload time so the feed can render
 * the correct aspect ratio instantly (no 1:1 → real-size snap). This script
 * fills the same fields for posts created before that change by reading the
 * authoritative dimensions from Cloudinary.
 *
 * Safe to re-run: it only $set's the two fields and skips docs that already
 * have them. It never deletes or overwrites other data.
 *
 * Usage:
 *   cd backend/services/content-service && set -a && . ./.env && set +a
 *   npm i mongodb            # one-time, anywhere on NODE_PATH
 *   node ../../scripts/backfill-media-dimensions.mjs
 *
 * Required env vars (already in content-service/.env):
 *   MONGO_URI, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *   DRY_RUN=1  → report what would change without writing.
 */
import { MongoClient } from 'mongodb';

const { MONGO_URI, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } =
  process.env;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!MONGO_URI || !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error(
    'Missing env. Need MONGO_URI, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.'
  );
  process.exit(1);
}

const auth =
  'Basic ' + Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');

/** public_id → { width, height } for every video asset in the account. */
async function fetchCloudinaryVideoDims() {
  const dims = {};
  let nextCursor;
  do {
    const url = new URL(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/video`
    );
    url.searchParams.set('max_results', '500');
    if (nextCursor) url.searchParams.set('next_cursor', nextCursor);
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Cloudinary ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const r of data.resources ?? []) {
      if (r.width && r.height) dims[r.public_id] = { width: r.width, height: r.height };
    }
    nextCursor = data.next_cursor;
  } while (nextCursor);
  return dims;
}

async function main() {
  console.log('Fetching Cloudinary video dimensions…');
  const dims = await fetchCloudinaryVideoDims();
  console.log(`  ${Object.keys(dims).length} video assets found.`);

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  // DB name comes from the connection string (atto_content).
  const contents = client.db().collection('contents');

  const cursor = contents.find({ content_type: { $in: ['video', 'reel'] } });
  let updated = 0;
  let alreadySet = 0;
  let noPublicId = 0;
  let noDims = 0;

  for await (const doc of cursor) {
    if (doc.metadata?.width && doc.metadata?.height) {
      alreadySet++;
      continue;
    }
    const publicId = (doc.file_paths ?? [])[0];
    if (!publicId || publicId.startsWith('http')) {
      noPublicId++;
      continue;
    }
    const d = dims[publicId];
    if (!d) {
      noDims++;
      continue;
    }
    if (!DRY_RUN) {
      await contents.updateOne(
        { _id: doc._id },
        { $set: { 'metadata.width': String(d.width), 'metadata.height': String(d.height) } }
      );
    }
    updated++;
  }

  await client.close();
  console.log(
    `${DRY_RUN ? '[DRY RUN] would update' : 'Updated'} ${updated} | already set ${alreadySet} | no public_id ${noPublicId} | no Cloudinary dims ${noDims}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

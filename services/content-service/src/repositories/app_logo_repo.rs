use bson::doc;
use chrono::Utc;
use mongodb::{
    options::{IndexOptions, UpdateOptions},
    Collection, Database, IndexModel,
};

use crate::models::AppLogo;

/// The main-logo singleton lives under this fixed key so there is exactly one
/// row; the unique index below guarantees it.
const SINGLETON_KEY: &str = "main";

/// The launch splash has its own singleton. It is a separate document (not a
/// field of the main one) so either can be set, replaced or cleared without
/// touching the other: the header wants a wide wordmark, the splash a mark.
const SPLASH_KEY: &str = "splash";

/// Key of the small stats doc that records the highest app build we have seen.
const STATS_KEY: &str = "build_stats";
/// Sanity ceiling so a bogus `?appBuild=` from the public endpoint can never
/// poison the admin hint with an absurd number.
const MAX_PLAUSIBLE_BUILD: i32 = 1_000_000;

/// Repository for the single main app-logo document. The admin web writes it
/// (`set_current`) and the mobile app reads it (`get_current`).
#[derive(Clone)]
pub struct AppLogoRepository {
    collection: Collection<AppLogo>,
    /// Tiny key/value collection for logo-related stats (e.g. max seen build).
    meta: Collection<bson::Document>,
}

impl AppLogoRepository {
    pub fn new(db: &Database) -> Self {
        Self {
            collection: db.collection::<AppLogo>("app_logo"),
            meta: db.collection::<bson::Document>("app_meta"),
        }
    }

    /// Record that a client on `build` hit the public endpoint, keeping the
    /// running maximum via `$max` (an atomic no-op when not greater — no read
    /// needed). Fire-and-forget from the handler so it never adds latency.
    pub async fn record_seen_build(&self, build: i32) -> Result<(), mongodb::error::Error> {
        if build <= 0 || build > MAX_PLAUSIBLE_BUILD {
            return Ok(());
        }
        self.meta
            .update_one(
                doc! { "key": STATS_KEY },
                doc! {
                    "$max": { "max_seen_build": build },
                    "$setOnInsert": { "key": STATS_KEY },
                },
                UpdateOptions::builder().upsert(true).build(),
            )
            .await?;
        Ok(())
    }

    /// Highest app build seen in the wild, or `None` if we have not seen one
    /// yet. Used only as an admin hint ("latest known build").
    pub async fn get_max_seen_build(&self) -> Result<Option<i32>, mongodb::error::Error> {
        let doc = self.meta.find_one(doc! { "key": STATS_KEY }, None).await?;
        Ok(doc.and_then(|d| d.get_i32("max_seen_build").ok()))
    }

    /// Ensure the unique `key` index exists so the singleton can never fork
    /// into multiple rows. Called once at startup; idempotent.
    pub async fn ensure_indexes(&self) -> Result<(), mongodb::error::Error> {
        let unique_key = IndexModel::builder()
            .keys(doc! { "key": 1 })
            .options(IndexOptions::builder().unique(true).build())
            .build();
        self.collection.create_indexes(vec![unique_key], None).await?;
        Ok(())
    }

    /// The current logo, or `None` if none has been set yet (app falls back to
    /// its bundled default).
    pub async fn get_current(&self) -> Result<Option<AppLogo>, mongodb::error::Error> {
        self.collection
            .find_one(doc! { "key": SINGLETON_KEY }, None)
            .await
    }

    /// Upsert the singleton: primary image plus the optional version target and
    /// fallback image. `min_version`/`fallback_image_url` are always written
    /// (to `null` when absent) so clearing them on a later save actually clears.
    pub async fn set_current(
        &self,
        image_url: &str,
        min_version: Option<i32>,
        fallback_image_url: Option<&str>,
    ) -> Result<AppLogo, mongodb::error::Error> {
        let now = Utc::now();
        let filter = doc! { "key": SINGLETON_KEY };
        let min_v = match min_version {
            Some(v) => bson::Bson::Int32(v),
            None => bson::Bson::Null,
        };
        let fallback = match fallback_image_url {
            Some(u) if !u.is_empty() => bson::Bson::String(u.to_string()),
            _ => bson::Bson::Null,
        };
        let update = doc! {
            "$set": {
                "image_url": image_url,
                "min_version": min_v,
                "fallback_image_url": fallback,
                "updated_at": bson::DateTime::from_chrono(now),
            },
            "$setOnInsert": {
                "key": SINGLETON_KEY,
                "created_at": bson::DateTime::from_chrono(now),
            },
        };
        self.collection
            .update_one(
                filter.clone(),
                update,
                UpdateOptions::builder().upsert(true).build(),
            )
            .await?;
        let logo = self.collection.find_one(filter, None).await?;
        logo.ok_or_else(|| {
            mongodb::error::Error::custom("app-logo upsert returned no document".to_string())
        })
    }

    /// The splash logo, or `None` when the splash should follow the main logo.
    pub async fn get_splash(&self) -> Result<Option<AppLogo>, mongodb::error::Error> {
        self.collection
            .find_one(doc! { "key": SPLASH_KEY }, None)
            .await
    }

    /// Set the splash logo. Same document shape as the main logo; the version
    /// fields stay empty because the splash has no baked in wordmark to avoid.
    pub async fn set_splash(&self, image_url: &str) -> Result<AppLogo, mongodb::error::Error> {
        let now = Utc::now();
        let filter = doc! { "key": SPLASH_KEY };
        let update = doc! {
            "$set": {
                "image_url": image_url,
                "min_version": bson::Bson::Null,
                "fallback_image_url": bson::Bson::Null,
                "updated_at": bson::DateTime::from_chrono(now),
            },
            "$setOnInsert": {
                "key": SPLASH_KEY,
                "created_at": bson::DateTime::from_chrono(now),
            },
        };
        self.collection
            .update_one(
                filter.clone(),
                update,
                UpdateOptions::builder().upsert(true).build(),
            )
            .await?;
        let logo = self.collection.find_one(filter, None).await?;
        logo.ok_or_else(|| {
            mongodb::error::Error::custom("splash-logo upsert returned no document".to_string())
        })
    }

    /// Remove the splash logo so the splash follows the main logo again.
    pub async fn clear_splash(&self) -> Result<bool, mongodb::error::Error> {
        let res = self
            .collection
            .delete_one(doc! { "key": SPLASH_KEY }, None)
            .await?;
        Ok(res.deleted_count > 0)
    }
}

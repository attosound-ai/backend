use bson::{doc, oid::ObjectId, Document};
use futures::TryStreamExt;
use mongodb::{Collection, Database};

use crate::models::Content;

#[derive(Clone)]
pub struct ContentRepository {
    collection: Collection<Content>,
}

impl ContentRepository {
    pub fn new(db: &Database) -> Self {
        Self {
            collection: db.collection::<Content>("contents"),
        }
    }

    pub async fn insert(&self, content: &Content) -> Result<ObjectId, mongodb::error::Error> {
        let result = self.collection.insert_one(content, None).await?;
        let id = result
            .inserted_id
            .as_object_id()
            .expect("inserted_id should be ObjectId");
        Ok(id)
    }

    pub async fn find_by_id(&self, id: &ObjectId) -> Result<Option<Content>, mongodb::error::Error> {
        self.collection.find_one(doc! { "_id": id }, None).await
    }

    pub async fn find_by_ids(
        &self,
        ids: &[ObjectId],
    ) -> Result<Vec<Content>, mongodb::error::Error> {
        let filter = doc! { "_id": { "$in": ids } };
        let cursor = self.collection.find(filter, None).await?;
        cursor.try_collect().await
    }

    pub async fn find_paginated(
        &self,
        page: u64,
        limit: i64,
    ) -> Result<(Vec<Content>, u64), mongodb::error::Error> {
        let total = self.collection.count_documents(None, None).await?;
        let skip = (page.saturating_sub(1)) * (limit as u64);
        let options = mongodb::options::FindOptions::builder()
            .skip(skip)
            .limit(limit)
            .sort(doc! { "created_at": -1 })
            .build();
        let cursor = self.collection.find(None, options).await?;
        let contents: Vec<Content> = cursor.try_collect().await?;
        Ok((contents, total))
    }

    pub async fn find_by_author_paginated(
        &self,
        author_id: &str,
        page: u64,
        limit: i64,
    ) -> Result<(Vec<Content>, u64), mongodb::error::Error> {
        let filter = doc! { "author_id": author_id };
        let total = self
            .collection
            .count_documents(filter.clone(), None)
            .await?;
        let skip = (page.saturating_sub(1)) * (limit as u64);
        let options = mongodb::options::FindOptions::builder()
            .skip(skip)
            .limit(limit)
            .sort(doc! { "created_at": -1 })
            .build();
        let cursor = self.collection.find(filter, options).await?;
        let contents: Vec<Content> = cursor.try_collect().await?;
        Ok((contents, total))
    }

    pub async fn find_with_cursor(
        &self,
        cursor_id: Option<&ObjectId>,
        limit: i64,
        filter: Option<Document>,
    ) -> Result<(Vec<Content>, u64), mongodb::error::Error> {
        let base_filter = filter.unwrap_or_else(|| doc! {});
        let total = self
            .collection
            .count_documents(base_filter.clone(), None)
            .await?;

        let query_filter = if let Some(cursor_oid) = cursor_id {
            let mut f = base_filter;
            f.insert("_id", doc! { "$lt": cursor_oid });
            f
        } else {
            base_filter
        };

        let options = mongodb::options::FindOptions::builder()
            .limit(limit + 1) // fetch one extra to check has_more
            .sort(doc! { "_id": -1 })
            .build();
        let cursor = self.collection.find(query_filter, options).await?;
        let contents: Vec<Content> = cursor.try_collect().await?;
        Ok((contents, total))
    }

    pub async fn delete_by_id(&self, id: &ObjectId) -> Result<bool, mongodb::error::Error> {
        let result = self.collection.delete_one(doc! { "_id": id }, None).await?;
        Ok(result.deleted_count > 0)
    }

    pub async fn delete_by_id_and_author(
        &self,
        id: &ObjectId,
        author_id: &str,
    ) -> Result<bool, mongodb::error::Error> {
        let result = self
            .collection
            .delete_one(doc! { "_id": id, "author_id": author_id }, None)
            .await?;
        Ok(result.deleted_count > 0)
    }
}

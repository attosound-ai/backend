use bson::{self, oid::ObjectId};
use chrono::Utc;
use log::info;
use std::collections::HashMap;
use thiserror::Error;

use crate::kafka::KafkaProducer;
use crate::models::{is_valid_content_type, Content, CreateContentInput, UpdateContentInput};
use crate::repositories::ContentRepository;

#[derive(Debug, Error)]
pub enum ContentError {
    #[error("Content not found")]
    NotFound,
    #[error("Invalid content type: {0}. Must be one of: audio, image, text")]
    InvalidContentType(String),
    #[error("Invalid ID format: {0}")]
    InvalidId(String),
    #[error("Unauthorized: you are not the author of this content")]
    Unauthorized,
    #[error("Database error: {0}")]
    DatabaseError(#[from] mongodb::error::Error),
}

#[derive(Clone)]
pub struct ContentService {
    repo: ContentRepository,
    kafka: KafkaProducer,
}

impl ContentService {
    pub fn new(repo: ContentRepository, kafka: KafkaProducer) -> Self {
        Self { repo, kafka }
    }

    pub async fn create_content(&self, input: CreateContentInput) -> Result<Content, ContentError> {
        if !is_valid_content_type(&input.content_type) {
            return Err(ContentError::InvalidContentType(input.content_type));
        }

        let now = Utc::now();
        let content = Content {
            id: None,
            author_id: input.author_id,
            content_type: input.content_type,
            title: input.title,
            text_content: input.text_content,
            file_paths: input.file_paths,
            metadata: input.metadata,
            tags: input.tags,
            created_at: now,
            updated_at: now,
        };

        let inserted_id = self.repo.insert(&content).await?;

        let mut created = content;
        created.id = Some(inserted_id);

        // Publish to Kafka
        let event = serde_json::json!({
            "content_id": inserted_id.to_hex(),
            "author_id": &created.author_id,
            "content_type": &created.content_type,
            "title": &created.title,
            "created_at": created.created_at.to_rfc3339(),
        });
        self.kafka
            .publish(
                "content.published",
                &inserted_id.to_hex(),
                &event.to_string(),
            )
            .await;

        info!("Created content id={}", inserted_id.to_hex());
        Ok(created)
    }

    pub async fn get_content(&self, id_str: &str) -> Result<Content, ContentError> {
        let oid = ObjectId::parse_str(id_str)
            .map_err(|_| ContentError::InvalidId(id_str.to_string()))?;
        self.repo
            .find_by_id(&oid)
            .await?
            .ok_or(ContentError::NotFound)
    }

    pub async fn get_content_batch(
        &self,
        ids: &[String],
    ) -> Result<Vec<Content>, ContentError> {
        let oids: Vec<ObjectId> = ids
            .iter()
            .filter_map(|s| ObjectId::parse_str(s).ok())
            .collect();
        if oids.is_empty() {
            return Ok(vec![]);
        }
        let contents = self.repo.find_by_ids(&oids).await?;
        Ok(contents)
    }

    pub async fn list_content(
        &self,
        page: u64,
        limit: i64,
    ) -> Result<(Vec<Content>, u64), ContentError> {
        let (contents, total) = self.repo.find_paginated(page, limit).await?;
        Ok((contents, total))
    }

    pub async fn list_by_author(
        &self,
        author_id: &str,
        page: u64,
        limit: i64,
    ) -> Result<(Vec<Content>, u64), ContentError> {
        let (contents, total) = self
            .repo
            .find_by_author_paginated(author_id, page, limit)
            .await?;
        Ok((contents, total))
    }

    pub async fn list_with_cursor(
        &self,
        cursor: Option<&str>,
        limit: i64,
        author_id: Option<&str>,
    ) -> Result<(Vec<Content>, bool, u64), ContentError> {
        let cursor_oid = match cursor {
            Some(c) if !c.is_empty() => {
                Some(ObjectId::parse_str(c).map_err(|_| ContentError::InvalidId(c.to_string()))?)
            }
            _ => None,
        };

        let filter = author_id.map(|a| bson::doc! { "author_id": a });
        let (mut contents, total) = self
            .repo
            .find_with_cursor(cursor_oid.as_ref(), limit, filter)
            .await?;

        let has_more = contents.len() as i64 > limit;
        if has_more {
            contents.truncate(limit as usize);
        }

        Ok((contents, has_more, total))
    }

    pub async fn update_content(
        &self,
        id_str: &str,
        author_id: &str,
        input: UpdateContentInput,
    ) -> Result<Content, ContentError> {
        let oid = ObjectId::parse_str(id_str)
            .map_err(|_| ContentError::InvalidId(id_str.to_string()))?;

        let mut update_doc = bson::Document::new();
        if let Some(text) = &input.text_content {
            update_doc.insert("text_content", text.clone());
        }
        if let Some(tags) = &input.tags {
            update_doc.insert("tags", bson::to_bson(tags).unwrap_or_default());
        }
        if let Some(metadata) = &input.metadata {
            update_doc.insert("metadata", bson::to_bson(metadata).unwrap_or_default());
        }
        if update_doc.is_empty() {
            return self.get_content(id_str).await;
        }

        // Fetch the original BEFORE updating so we can merge changes
        let mut original = self.get_content(id_str).await?;
        if original.author_id != author_id {
            return Err(ContentError::Unauthorized);
        }

        info!("Updating content id={} author={} fields={:?}", id_str, author_id, update_doc);
        let matched = self
            .repo
            .update_fields(&oid, author_id, update_doc)
            .await
            .map_err(|e| { log::error!("MongoDB update error: {:?}", e); ContentError::DatabaseError(e) })?;
        if !matched {
            return Err(ContentError::NotFound);
        }

        // Merge changes into the original to avoid re-reading (which may fail due to DateTime type mismatch)
        if let Some(text) = &input.text_content {
            original.text_content = Some(text.clone());
        }
        if let Some(tags) = &input.tags {
            original.tags = tags.clone();
        }
        if let Some(metadata) = &input.metadata {
            original.metadata = metadata.clone();
        }
        original.updated_at = Utc::now();
        let updated = original;

        // Publish Kafka event
        let event = serde_json::json!({
            "content_id": id_str,
            "author_id": author_id,
            "updated_at": Utc::now().to_rfc3339(),
        });
        self.kafka
            .publish("content.updated", id_str, &event.to_string())
            .await;

        info!("Updated content id={}", id_str);
        Ok(updated)
    }

    pub async fn delete_content(
        &self,
        id_str: &str,
        author_id: &str,
    ) -> Result<(), ContentError> {
        let oid = ObjectId::parse_str(id_str)
            .map_err(|_| ContentError::InvalidId(id_str.to_string()))?;

        let deleted = self.repo.delete_by_id_and_author(&oid, author_id).await?;
        if !deleted {
            // Either not found or not the author
            let exists = self.repo.find_by_id(&oid).await?;
            if exists.is_none() {
                return Err(ContentError::NotFound);
            }
            return Err(ContentError::Unauthorized);
        }

        // Publish to Kafka
        let event = serde_json::json!({
            "content_id": id_str,
            "author_id": author_id,
            "deleted_at": Utc::now().to_rfc3339(),
        });
        self.kafka
            .publish("content.deleted", id_str, &event.to_string())
            .await;

        info!("Deleted content id={}", id_str);
        Ok(())
    }

    /// Delete ALL content for a given author (used on account deletion).
    pub async fn delete_all_by_author(&self, author_id: &str) -> Result<u64, ContentError> {
        let count = self.repo.delete_all_by_author(author_id).await?;
        if count > 0 {
            let event = serde_json::json!({
                "author_id": author_id,
                "deleted_count": count,
                "deleted_at": Utc::now().to_rfc3339(),
            });
            self.kafka
                .publish("content.author_purged", author_id, &event.to_string())
                .await;
            info!("Purged {} content documents for author {}", count, author_id);
        }
        Ok(count)
    }

    /// Delete content without author check (used by gRPC)
    pub async fn delete_content_by_author(
        &self,
        id_str: &str,
        author_id: &str,
    ) -> Result<(), ContentError> {
        self.delete_content(id_str, author_id).await
    }

    /// Search content by query string, optionally filtered by content_type.
    pub async fn search_content(
        &self,
        query: &str,
        content_type: Option<&str>,
        limit: i64,
    ) -> Result<Vec<Content>, ContentError> {
        if query.trim().is_empty() {
            return Ok(vec![]);
        }
        let results = self.repo.search(query, content_type, limit).await?;
        Ok(results)
    }

    pub fn content_to_metadata_map(metadata: &HashMap<String, String>) -> HashMap<String, String> {
        metadata.clone()
    }
}

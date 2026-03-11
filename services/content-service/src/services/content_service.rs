use bson::oid::ObjectId;
use chrono::Utc;
use log::info;
use std::collections::HashMap;
use thiserror::Error;

use crate::kafka::KafkaProducer;
use crate::models::{is_valid_content_type, Content, CreateContentInput};
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

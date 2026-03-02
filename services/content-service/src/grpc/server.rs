use tonic::{Request, Response, Status};

use crate::models::CreateContentInput;
use crate::services::ContentService;

// Import generated protobuf types – nested so that
// `super::common::*` references from atto.content resolve correctly.
pub mod atto_proto {
    pub mod common {
        tonic::include_proto!("atto.common");
    }
    pub mod content {
        tonic::include_proto!("atto.content");
    }
}

pub use atto_proto::common as common_proto;
pub use atto_proto::content as content_proto;

use content_proto::content_service_server::{ContentService as GrpcContentService, ContentServiceServer};
use content_proto::{
    ContentResponse as ProtoContentResponse, CreateContentRequest, DeleteContentRequest,
    GetContentBatchRequest, GetContentBatchResponse, GetContentByAuthorRequest,
    GetContentRequest,
};

pub struct ContentGrpcServer {
    service: ContentService,
}

impl ContentGrpcServer {
    pub fn new(service: ContentService) -> Self {
        Self { service }
    }

    pub fn into_service(self) -> ContentServiceServer<Self> {
        ContentServiceServer::new(self)
    }
}

fn content_to_proto(c: crate::models::Content) -> ProtoContentResponse {
    ProtoContentResponse {
        id: c.id.map(|oid| oid.to_hex()).unwrap_or_default(),
        author_id: c.author_id,
        content_type: c.content_type,
        text_content: c.text_content.unwrap_or_default(),
        file_paths: c.file_paths,
        metadata: c.metadata,
        tags: c.tags,
        created_at: c.created_at.to_rfc3339(),
        updated_at: c.updated_at.to_rfc3339(),
    }
}

#[tonic::async_trait]
impl GrpcContentService for ContentGrpcServer {
    async fn get_content(
        &self,
        request: Request<GetContentRequest>,
    ) -> Result<Response<ProtoContentResponse>, Status> {
        let req = request.into_inner();
        match self.service.get_content(&req.content_id).await {
            Ok(content) => Ok(Response::new(content_to_proto(content))),
            Err(crate::services::ContentError::NotFound) => {
                Err(Status::not_found("Content not found"))
            }
            Err(crate::services::ContentError::InvalidId(id)) => {
                Err(Status::invalid_argument(format!("Invalid ID: {}", id)))
            }
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn get_content_batch(
        &self,
        request: Request<GetContentBatchRequest>,
    ) -> Result<Response<GetContentBatchResponse>, Status> {
        let req = request.into_inner();

        let limit = req
            .pagination
            .as_ref()
            .map(|p| p.limit as i64)
            .unwrap_or(20)
            .min(100)
            .max(1);

        let cursor = req.pagination.as_ref().map(|p| p.cursor.clone());

        if !req.content_ids.is_empty() {
            // Batch fetch by IDs
            match self.service.get_content_batch(&req.content_ids).await {
                Ok(contents) => {
                    let total = contents.len() as i64;
                    let proto_contents: Vec<ProtoContentResponse> =
                        contents.into_iter().map(content_to_proto).collect();
                    Ok(Response::new(GetContentBatchResponse {
                        contents: proto_contents,
                        meta: Some(common_proto::PaginatedMeta {
                            next_cursor: String::new(),
                            has_more: false,
                            total,
                        }),
                    }))
                }
                Err(e) => Err(Status::internal(e.to_string())),
            }
        } else {
            // Paginated list
            let cursor_str = cursor.as_deref();
            match self
                .service
                .list_with_cursor(cursor_str, limit, None)
                .await
            {
                Ok((contents, has_more, total)) => {
                    let next_cursor = if has_more {
                        contents
                            .last()
                            .and_then(|c| c.id.as_ref())
                            .map(|oid| oid.to_hex())
                            .unwrap_or_default()
                    } else {
                        String::new()
                    };

                    let proto_contents: Vec<ProtoContentResponse> =
                        contents.into_iter().map(content_to_proto).collect();
                    Ok(Response::new(GetContentBatchResponse {
                        contents: proto_contents,
                        meta: Some(common_proto::PaginatedMeta {
                            next_cursor,
                            has_more,
                            total: total as i64,
                        }),
                    }))
                }
                Err(e) => Err(Status::internal(e.to_string())),
            }
        }
    }

    async fn create_content(
        &self,
        request: Request<CreateContentRequest>,
    ) -> Result<Response<ProtoContentResponse>, Status> {
        let req = request.into_inner();

        let input = CreateContentInput {
            author_id: req.author_id,
            content_type: req.content_type,
            title: String::new(),
            text_content: if req.text_content.is_empty() {
                None
            } else {
                Some(req.text_content)
            },
            file_paths: req.file_paths,
            metadata: req.metadata,
            tags: req.tags,
        };

        match self.service.create_content(input).await {
            Ok(content) => Ok(Response::new(content_to_proto(content))),
            Err(crate::services::ContentError::InvalidContentType(ct)) => Err(
                Status::invalid_argument(format!("Invalid content type: {}", ct)),
            ),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn delete_content(
        &self,
        request: Request<DeleteContentRequest>,
    ) -> Result<Response<common_proto::Empty>, Status> {
        let req = request.into_inner();
        match self
            .service
            .delete_content_by_author(&req.content_id, &req.author_id)
            .await
        {
            Ok(()) => Ok(Response::new(common_proto::Empty {})),
            Err(crate::services::ContentError::NotFound) => {
                Err(Status::not_found("Content not found"))
            }
            Err(crate::services::ContentError::Unauthorized) => {
                Err(Status::permission_denied("Not the author"))
            }
            Err(crate::services::ContentError::InvalidId(id)) => {
                Err(Status::invalid_argument(format!("Invalid ID: {}", id)))
            }
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn get_content_by_author(
        &self,
        request: Request<GetContentByAuthorRequest>,
    ) -> Result<Response<GetContentBatchResponse>, Status> {
        let req = request.into_inner();

        let limit = req
            .pagination
            .as_ref()
            .map(|p| p.limit as i64)
            .unwrap_or(20)
            .min(100)
            .max(1);

        let cursor = req.pagination.as_ref().map(|p| p.cursor.clone());
        let cursor_str = cursor.as_deref();

        match self
            .service
            .list_with_cursor(cursor_str, limit, Some(&req.author_id))
            .await
        {
            Ok((contents, has_more, total)) => {
                let next_cursor = if has_more {
                    contents
                        .last()
                        .and_then(|c| c.id.as_ref())
                        .map(|oid| oid.to_hex())
                        .unwrap_or_default()
                } else {
                    String::new()
                };

                let proto_contents: Vec<ProtoContentResponse> =
                    contents.into_iter().map(content_to_proto).collect();
                Ok(Response::new(GetContentBatchResponse {
                    contents: proto_contents,
                    meta: Some(common_proto::PaginatedMeta {
                        next_cursor,
                        has_more,
                        total: total as i64,
                    }),
                }))
            }
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }
}

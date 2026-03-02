use thiserror::Error;

#[derive(Debug, Error)]
pub enum CloudinaryError {
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("Cloudinary API error: {0}")]
    ApiError(String),

    #[error("Invalid context: {0}")]
    InvalidContext(String),

    #[error("Invalid resource type: {0}")]
    InvalidResourceType(String),
}

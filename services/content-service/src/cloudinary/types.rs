use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Parameters the frontend needs to upload directly to Cloudinary.
#[derive(Debug, Serialize)]
pub struct SignedUploadParams {
    pub upload_url: String,
    pub api_key: String,
    pub timestamp: i64,
    pub signature: String,
    pub folder: String,
    pub public_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eager: Option<String>,
    pub resource_type: String,
    #[serde(flatten)]
    pub extra_params: HashMap<String, String>,
}

/// Request from the frontend to get signed upload params.
#[derive(Debug, Deserialize)]
pub struct SignUploadRequest {
    pub context: String,
    pub resource_type: String,
}

/// Response from Cloudinary's destroy API.
#[derive(Debug, Deserialize)]
pub struct DestroyResponse {
    pub result: String,
}

/// Request to delete media.
#[derive(Debug, Deserialize)]
pub struct DeleteMediaRequest {
    pub resource_type: Option<String>,
}

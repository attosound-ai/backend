use reqwest::Client;
use sha1::{Digest, Sha1};
use std::collections::HashMap;

use super::config::CloudinaryConfig;
use super::error::CloudinaryError;
use super::transformations::TransformationPresets;
use super::types::{DestroyResponse, SignedUploadParams};

/// Cloudinary API client.
/// Single Responsibility: only handles Cloudinary API interactions.
#[derive(Clone)]
pub struct CloudinaryClient {
    config: CloudinaryConfig,
    http: Client,
}

impl CloudinaryClient {
    pub fn new(config: CloudinaryConfig) -> Self {
        Self {
            config,
            http: Client::new(),
        }
    }

    /// Generate signed upload parameters for the frontend.
    /// The frontend will POST directly to Cloudinary with these params.
    pub fn sign_upload(
        &self,
        folder: &str,
        public_id: &str,
        resource_type: &str,
        eager: Option<&str>,
        eager_async: bool,
    ) -> SignedUploadParams {
        let timestamp = chrono::Utc::now().timestamp();

        let mut params: Vec<(String, String)> = vec![
            ("folder".into(), folder.into()),
            ("public_id".into(), public_id.into()),
            ("timestamp".into(), timestamp.to_string()),
        ];

        let has_eager = eager.map(|e| !e.is_empty()).unwrap_or(false);
        if let Some(e) = eager {
            if !e.is_empty() {
                params.push(("eager".into(), e.into()));
            }
        }

        // HLS transcoding is heavy → process eager transforms asynchronously so
        // the upload returns immediately. Only meaningful when there's an eager.
        let use_async = eager_async && has_eager;
        if use_async {
            params.push(("eager_async".into(), "true".into()));
        }

        // Sort alphabetically for signature
        params.sort_by(|a, b| a.0.cmp(&b.0));

        let string_to_sign = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        let signature = self.sign(&string_to_sign);

        SignedUploadParams {
            upload_url: self.config.upload_url(resource_type),
            api_key: self.config.api_key.clone(),
            timestamp,
            signature,
            folder: folder.into(),
            public_id: public_id.into(),
            eager: eager.map(String::from),
            eager_async: use_async,
            resource_type: resource_type.into(),
            extra_params: HashMap::new(),
        }
    }

    /// Resolve folder and eager transformations for a given context.
    pub fn resolve_context(context: &str) -> Option<(&'static str, Option<String>)> {
        match context {
            "avatar" => Some(("atto/avatars", Some(TransformationPresets::avatar_eager()))),
            "content" => Some((
                "atto/content",
                Some(TransformationPresets::content_image_eager()),
            )),
            "audio" => Some(("atto/audio", TransformationPresets::audio_eager())),
            "chat" => Some(("atto/chat", Some(TransformationPresets::chat_image_eager()))),
            // Video/reel: eager-generate the adaptive HLS stream + thumbnail.
            // These are processed asynchronously (see `context_is_async`).
            "video" => Some(("atto/videos", Some(TransformationPresets::video_eager()))),
            "reel" => Some(("atto/reels", Some(TransformationPresets::reel_eager()))),
            _ => None,
        }
    }

    /// Whether a context's eager transforms must be generated asynchronously
    /// (true for video/reel because HLS transcoding is slow).
    pub fn context_is_async(context: &str) -> bool {
        matches!(context, "video" | "reel")
    }

    /// Delete a resource from Cloudinary.
    pub async fn destroy(
        &self,
        public_id: &str,
        resource_type: &str,
    ) -> Result<(), CloudinaryError> {
        let timestamp = chrono::Utc::now().timestamp();
        let string_to_sign = format!("public_id={}&timestamp={}", public_id, timestamp);
        let signature = self.sign(&string_to_sign);

        let response = self
            .http
            .post(&self.config.destroy_url(resource_type))
            .form(&[
                ("public_id", public_id),
                ("timestamp", &timestamp.to_string()),
                ("api_key", &self.config.api_key),
                ("signature", &signature),
            ])
            .send()
            .await?;

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(CloudinaryError::ApiError(body));
        }

        let result: DestroyResponse = serde_json::from_str(
            &response.text().await.unwrap_or_default(),
        )
        .unwrap_or(DestroyResponse {
            result: "ok".into(),
        });

        if result.result != "ok" && result.result != "not found" {
            return Err(CloudinaryError::ApiError(format!(
                "Destroy failed: {}",
                result.result
            )));
        }

        Ok(())
    }

    fn sign(&self, string_to_sign: &str) -> String {
        let to_sign = format!("{}{}", string_to_sign, self.config.api_secret);
        let mut hasher = Sha1::new();
        hasher.update(to_sign.as_bytes());
        hex::encode(hasher.finalize())
    }
}

use std::env;

#[derive(Debug, Clone)]
pub struct CloudinaryConfig {
    pub cloud_name: String,
    pub api_key: String,
    pub api_secret: String,
}

impl CloudinaryConfig {
    pub fn from_env() -> Self {
        Self {
            cloud_name: env::var("CLOUDINARY_CLOUD_NAME")
                .expect("CLOUDINARY_CLOUD_NAME must be set"),
            api_key: env::var("CLOUDINARY_API_KEY")
                .expect("CLOUDINARY_API_KEY must be set"),
            api_secret: env::var("CLOUDINARY_API_SECRET")
                .expect("CLOUDINARY_API_SECRET must be set"),
        }
    }

    pub fn upload_url(&self, resource_type: &str) -> String {
        format!(
            "https://api.cloudinary.com/v1_1/{}/{}/upload",
            self.cloud_name, resource_type
        )
    }

    pub fn destroy_url(&self, resource_type: &str) -> String {
        format!(
            "https://api.cloudinary.com/v1_1/{}/{}/destroy",
            self.cloud_name, resource_type
        )
    }
}

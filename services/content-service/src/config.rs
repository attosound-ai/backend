use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub http_port: u16,
    pub grpc_port: u16,
    pub mongo_uri: String,
    pub kafka_brokers: String,
    pub consul_addr: Option<String>,
    pub jaeger_endpoint: Option<String>,
    pub upload_dir: String,
    pub max_file_size: usize,
    pub jwt_secret: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            http_port: env::var("HTTP_PORT")
                .unwrap_or_else(|_| "8081".to_string())
                .parse()
                .expect("HTTP_PORT must be a valid port number"),
            grpc_port: env::var("GRPC_PORT")
                .unwrap_or_else(|_| "50052".to_string())
                .parse()
                .expect("GRPC_PORT must be a valid port number"),
            mongo_uri: env::var("MONGO_URI").unwrap_or_else(|_| {
                "mongodb://atto:atto_dev@localhost:27017/atto_content?authSource=admin".to_string()
            }),
            kafka_brokers: env::var("KAFKA_BROKERS")
                .unwrap_or_else(|_| "localhost:9092".to_string()),
            consul_addr: env::var("CONSUL_ADDR").ok(),
            jaeger_endpoint: env::var("JAEGER_ENDPOINT").ok(),
            upload_dir: env::var("UPLOAD_DIR").unwrap_or_else(|_| "./uploads".to_string()),
            max_file_size: env::var("MAX_FILE_SIZE")
                .unwrap_or_else(|_| "52428800".to_string())
                .parse()
                .expect("MAX_FILE_SIZE must be a valid number"),
            jwt_secret: env::var("JWT_SECRET")
                .expect("JWT_SECRET must be set"),
        }
    }
}

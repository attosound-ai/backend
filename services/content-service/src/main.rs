mod cloudinary;
mod config;
mod grpc;
mod handlers;
mod kafka;
mod middleware;
mod models;
mod repositories;
mod services;

use actix_web::{web, App, HttpServer};
use log::info;
use mongodb::Client;
use std::net::SocketAddr;
use tonic::transport::Server as TonicServer;

use cloudinary::{CloudinaryClient, CloudinaryConfig};
use config::Config;
use grpc::ContentGrpcServer;
use handlers::{content_handler, health_handler, media_handler};
use kafka::KafkaProducer;
use repositories::ContentRepository;
use services::ContentService;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenv::dotenv().ok();
    env_logger::init();

    let config = Config::from_env();
    info!(
        "Starting content-service (HTTP: {}, gRPC: {})",
        config.http_port, config.grpc_port
    );

    // Connect to MongoDB
    let mongo_client = Client::with_uri_str(&config.mongo_uri)
        .await
        .expect("Failed to connect to MongoDB");
    let db = mongo_client.default_database().unwrap_or_else(|| {
        mongo_client.database("atto_content")
    });
    info!("Connected to MongoDB");

    // Create repository, Kafka producer, and service
    let repo = ContentRepository::new(&db);
    let kafka_producer = KafkaProducer::new(&config.kafka_brokers);
    let content_service = ContentService::new(repo, kafka_producer);

    // Ensure upload directory exists (for legacy local uploads)
    tokio::fs::create_dir_all(&config.upload_dir)
        .await
        .expect("Failed to create upload directory");

    // Initialize Cloudinary client
    let cloudinary_config = CloudinaryConfig::from_env();
    info!("Cloudinary configured for cloud: {}", cloudinary_config.cloud_name);
    let cloudinary_client = CloudinaryClient::new(cloudinary_config);

    // Spawn gRPC server in background
    let grpc_service = content_service.clone();
    let grpc_port = config.grpc_port;
    tokio::spawn(async move {
        let addr: SocketAddr = format!("0.0.0.0:{}", grpc_port)
            .parse()
            .expect("Invalid gRPC address");
        info!("gRPC server listening on {}", addr);

        let grpc_server = ContentGrpcServer::new(grpc_service);
        if let Err(e) = TonicServer::builder()
            .add_service(grpc_server.into_service())
            .serve(addr)
            .await
        {
            log::error!("gRPC server error: {}", e);
        }
    });

    // Start Actix-web HTTP server
    let http_port = config.http_port;
    let config_data = web::Data::new(config);
    let service_data = web::Data::new(content_service);
    let cloudinary_data = web::Data::new(cloudinary_client);

    info!("HTTP server listening on 0.0.0.0:{}", http_port);

    HttpServer::new(move || {
        App::new()
            .app_data(config_data.clone())
            .app_data(service_data.clone())
            .app_data(cloudinary_data.clone())
            .service(health_handler::health_check)
            .service(media_handler::sign_upload)
            .service(media_handler::upload_media)
            .service(media_handler::delete_media)
            .service(content_handler::create_content)
            .service(content_handler::search_content)
            .service(content_handler::get_content)
            .service(content_handler::list_content)
            .service(content_handler::delete_content)
    })
    .bind(format!("[::]:{}",  http_port))?
    .run()
    .await
}

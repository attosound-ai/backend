use log::{error, info, warn};
use rdkafka::config::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use std::time::Duration;

#[derive(Clone)]
pub struct KafkaProducer {
    producer: Option<FutureProducer>,
}

impl KafkaProducer {
    pub fn new(brokers: &str) -> Self {
        let producer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("message.timeout.ms", "5000")
            .set("queue.buffering.max.ms", "100")
            .create::<FutureProducer>();

        match producer {
            Ok(p) => {
                info!("Kafka producer connected to {}", brokers);
                Self { producer: Some(p) }
            }
            Err(e) => {
                warn!(
                    "Failed to create Kafka producer ({}). Events will not be published: {}",
                    brokers, e
                );
                Self { producer: None }
            }
        }
    }

    pub async fn publish(&self, topic: &str, key: &str, payload: &str) {
        let producer = match &self.producer {
            Some(p) => p,
            None => {
                warn!(
                    "Kafka producer not available, skipping event on topic {}",
                    topic
                );
                return;
            }
        };

        let record = FutureRecord::to(topic).key(key).payload(payload);

        match producer.send(record, Duration::from_secs(5)).await {
            Ok((partition, offset)) => {
                info!(
                    "Published to topic={} partition={} offset={}",
                    topic, partition, offset
                );
            }
            Err((err, _)) => {
                error!("Failed to publish to topic {}: {}", topic, err);
            }
        }
    }
}

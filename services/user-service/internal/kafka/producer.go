package kafka

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"os"
	"strings"
	"time"

	kafkago "github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl/scram"
)

// Producer wraps the kafka-go writer to publish events.
type Producer struct {
	writers   map[string]*kafkago.Writer
	brokers   []string
	transport kafkago.RoundTripper
}

// Event represents a Kafka message payload.
type Event struct {
	Type      string      `json:"type"`
	Timestamp string      `json:"timestamp"`
	Data      interface{} `json:"data"`
}

// NewProducer creates a new Kafka producer for the given broker addresses.
// It pre-creates writers for the known user-service topics.
func NewProducer(brokers string) *Producer {
	brokerList := strings.Split(brokers, ",")

	var transport kafkago.RoundTripper
	if os.Getenv("KAFKA_USE_TLS") == "true" {
		mechanism, err := scram.Mechanism(
			scram.SHA256,
			os.Getenv("KAFKA_SASL_USERNAME"),
			os.Getenv("KAFKA_SASL_PASSWORD"),
		)
		if err != nil {
			log.Printf("[KAFKA] Failed to create SCRAM mechanism: %v", err)
		} else {
			transport = &kafkago.Transport{
				TLS:  &tls.Config{},
				SASL: mechanism,
			}
		}
	}

	p := &Producer{
		writers:   make(map[string]*kafkago.Writer),
		brokers:   brokerList,
		transport: transport,
	}

	topics := []string{"user.created", "user.updated", "user.verified"}
	for _, topic := range topics {
		p.writers[topic] = p.newWriter(topic)
	}

	return p
}

func (p *Producer) newWriter(topic string) *kafkago.Writer {
	w := &kafkago.Writer{
		Addr:         kafkago.TCP(p.brokers...),
		Topic:        topic,
		Balancer:     &kafkago.LeastBytes{},
		BatchTimeout: 10 * time.Millisecond,
		Async:        true,
	}
	if p.transport != nil {
		w.Transport = p.transport
	}
	return w
}

// Publish sends an event to the specified Kafka topic.
func (p *Producer) Publish(ctx context.Context, topic string, key string, data interface{}) error {
	writer, ok := p.writers[topic]
	if !ok {
		writer = p.newWriter(topic)
		p.writers[topic] = writer
	}

	event := Event{
		Type:      topic,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Data:      data,
	}

	value, err := json.Marshal(event)
	if err != nil {
		log.Printf("[KAFKA] Failed to marshal event for topic %s: %v", topic, err)
		return err
	}

	err = writer.WriteMessages(ctx, kafkago.Message{
		Key:   []byte(key),
		Value: value,
	})
	if err != nil {
		log.Printf("[KAFKA] Failed to publish to topic %s: %v", topic, err)
		return err
	}

	log.Printf("[KAFKA] Published event to topic %s with key %s", topic, key)
	return nil
}

// Close shuts down all Kafka writers gracefully.
func (p *Producer) Close() {
	for topic, writer := range p.writers {
		if err := writer.Close(); err != nil {
			log.Printf("[KAFKA] Error closing writer for topic %s: %v", topic, err)
		}
	}
}

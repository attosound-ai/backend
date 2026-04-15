import Config

# Disable real infrastructure for unit tests. The supervision tree in
# ChatService.Application skips Xandra, Kafka producer, and the bootstrap
# DDL when :infra_enabled is false, so tests don't need a live Cassandra
# or Kafka broker.
config :chat_service, :infra_enabled, false

# Run the Phoenix endpoint but without binding to a real port.
config :chat_service, ChatServiceWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  server: false,
  secret_key_base: String.duplicate("a", 64)

# Print only warnings and up during test runs.
config :logger, level: :warning

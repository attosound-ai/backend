import Config

config :chat_service, ChatServiceWeb.Endpoint,
  url: [host: "localhost"],
  render_errors: [
    formats: [json: ChatServiceWeb.ErrorView],
    layout: false
  ],
  pubsub_server: ChatService.PubSub,
  live_view: [signing_salt: "chat_service_salt"]

config :chat_service,
  cassandra_nodes: ["localhost:9042"],
  cassandra_keyspace: "atto_chat",
  kafka_brokers: [{"localhost", 9092}],
  user_service_grpc: "localhost:50051",
  consul_addr: "localhost:8500",
  jaeger_endpoint: "http://localhost:4318/v1/traces"

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

config :phoenix, :json_library, Jason

import_config "#{config_env()}.exs"

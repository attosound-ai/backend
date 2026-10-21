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

# --- Telemetry: Sentry (error tracking) ---
# DSN is intentionally nil by default so dev/test do not send events.
# It is populated from SENTRY_DSN in runtime.exs (prod).
config :sentry,
  dsn: nil,
  environment_name: config_env(),
  enable_source_code_context: true,
  root_source_code_paths: [File.cwd!()],
  # When dsn is nil Sentry no-ops, so this is safe everywhere.
  client: Sentry.HackneyClient

# --- Telemetry: PostHog (backend lifecycle events) ---
# Disabled until POSTHOG_API_KEY is provided (runtime.exs). When the api_key is
# nil the ChatService.Telemetry.Posthog helper becomes a no-op.
config :chat_service, ChatService.Telemetry.Posthog,
  api_key: nil,
  host: "https://us.i.posthog.com"

# --- Maintenance: read-only connection to user-service Postgres ---
# Used by `mix chat.cleanup_orphans` to load the set of live user ids.
config :chat_service, :user_service_db_url, nil

import_config "#{config_env()}.exs"

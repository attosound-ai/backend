import Config

config :chat_service, ChatServiceWeb.Endpoint,
  url: [host: "localhost", port: 4000],
  http: [ip: {0, 0, 0, 0}, port: 4000],
  cache_static_manifest: "priv/static/cache_manifest.json",
  server: true

config :logger, level: :info

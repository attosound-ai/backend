import Config

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  config :chat_service, ChatServiceWeb.Endpoint,
    http: [ip: {0, 0, 0, 0}, port: String.to_integer(System.get_env("PORT") || "4000")],
    secret_key_base: secret_key_base,
    server: true

  cassandra_nodes =
    (System.get_env("CASSANDRA_NODES") || "localhost:9042")
    |> String.split(",")
    |> Enum.map(fn node_str ->
      node_str = String.trim(node_str)
      case String.split(node_str, ":") do
        [host, port] -> "#{host}:#{port}"
        [host] -> "#{host}:9042"
      end
    end)

  cassandra_keyspace = System.get_env("CASSANDRA_KEYSPACE") || "atto_chat"

  kafka_brokers =
    (System.get_env("KAFKA_BROKERS") || "localhost:9092")
    |> String.split(",")
    |> Enum.map(fn broker ->
      [host, port] = String.split(String.trim(broker), ":")
      {host, String.to_integer(port)}
    end)

  config :chat_service,
    cassandra_nodes: cassandra_nodes,
    cassandra_keyspace: cassandra_keyspace,
    kafka_brokers: kafka_brokers,
    user_service_grpc: System.get_env("USER_SERVICE_GRPC") || "localhost:50051",
    consul_addr: System.get_env("CONSUL_ADDR") || "localhost:8500",
    jaeger_endpoint: System.get_env("JAEGER_ENDPOINT") || "http://localhost:4318/v1/traces"
end

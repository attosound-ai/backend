defmodule ChatService.Application do
  @moduledoc """
  The ChatService Application supervisor.
  Starts the Xandra connection pool, Kafka producer, PubSub, and Phoenix endpoint.
  """
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    cassandra_nodes = Application.get_env(:chat_service, :cassandra_nodes, ["localhost:9042"])
    cassandra_keyspace = Application.get_env(:chat_service, :cassandra_keyspace, "atto_chat")
    kafka_brokers = Application.get_env(:chat_service, :kafka_brokers, [{"localhost", 9092}])

    # Bootstrap keyspace and tables with a temporary connection (no keyspace).
    # The main Xandra.Cluster uses `keyspace: atto_chat` which sends USE atto_chat
    # on connect. If the keyspace doesn't exist yet, ALL pool connections die.
    bootstrap_cassandra(cassandra_nodes, cassandra_keyspace)

    children = [
      {Phoenix.PubSub, name: ChatService.PubSub},
      {Xandra.Cluster,
       name: ChatService.Repo,
       nodes: cassandra_nodes,
       pool_size: 10,
       keyspace: cassandra_keyspace},
      {ChatService.KafkaProducer, brokers: kafka_brokers},
      ChatServiceWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: ChatService.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    ChatServiceWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  # Opens a throwaway Xandra connection (no keyspace) to create the keyspace
  # and tables before the main cluster starts. Retries if Cassandra is still booting.
  defp bootstrap_cassandra(nodes, keyspace) do
    node = List.first(nodes) || "localhost:9042"

    case connect_with_retries(node, 10, 3_000) do
      {:ok, conn} ->
        run_ddl(conn, keyspace)
        Xandra.stop(conn)
        Logger.info("Cassandra bootstrap complete — keyspace #{keyspace} ready")

      {:error, reason} ->
        Logger.error("Cassandra bootstrap failed after retries: #{inspect(reason)}")
    end
  end

  defp connect_with_retries(_node, 0, _delay), do: {:error, :max_retries}

  defp connect_with_retries(node, retries, delay) do
    case Xandra.start_link(nodes: [node]) do
      {:ok, conn} ->
        {:ok, conn}

      {:error, reason} ->
        Logger.warning(
          "Cassandra not ready (#{inspect(reason)}), retrying in #{delay}ms " <>
            "(#{retries - 1} left)"
        )

        Process.sleep(delay)
        connect_with_retries(node, retries - 1, delay)
    end
  end

  defp run_ddl(conn, keyspace) do
    statements = [
      """
      CREATE KEYSPACE IF NOT EXISTS #{keyspace}
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
      """,
      """
      CREATE TABLE IF NOT EXISTS #{keyspace}.messages (
        conversation_id uuid,
        message_id timeuuid,
        sender_id text,
        content text,
        content_type text,
        is_read boolean,
        created_at timestamp,
        PRIMARY KEY (conversation_id, message_id)
      ) WITH CLUSTERING ORDER BY (message_id DESC)
      """,
      """
      CREATE TABLE IF NOT EXISTS #{keyspace}.conversations (
        user_id text,
        conversation_id uuid,
        participant_id text,
        participant_name text,
        last_message text,
        last_message_at timestamp,
        unread_count int,
        updated_at timestamp,
        PRIMARY KEY (user_id, updated_at, conversation_id)
      ) WITH CLUSTERING ORDER BY (updated_at DESC, conversation_id ASC)
      """
    ]

    Enum.each(statements, fn stmt ->
      case Xandra.execute(conn, stmt) do
        {:ok, _} -> :ok
        {:error, reason} -> Logger.error("DDL failed: #{inspect(reason)}\n#{stmt}")
      end
    end)
  end
end

defmodule ChatService.Application do
  @moduledoc """
  The ChatService Application supervisor.
  Starts the Xandra connection pool, Kafka producer, PubSub, and Phoenix endpoint.
  """
  use Application

  @impl true
  def start(_type, _args) do
    cassandra_nodes = Application.get_env(:chat_service, :cassandra_nodes, ["localhost:9042"])
    cassandra_keyspace = Application.get_env(:chat_service, :cassandra_keyspace, "atto_chat")

    kafka_brokers = Application.get_env(:chat_service, :kafka_brokers, [{"localhost", 9092}])

    children = [
      {Phoenix.PubSub, name: ChatService.PubSub},
      {Xandra.Cluster,
       name: ChatService.Repo,
       nodes: cassandra_nodes,
       pool_size: 10,
       keyspace: cassandra_keyspace},
      {Task, fn -> setup_keyspace_and_tables(cassandra_keyspace) end},
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

  defp setup_keyspace_and_tables(keyspace) do
    # Wait briefly for the cluster connection to be ready
    Process.sleep(2_000)

    create_keyspace_query = """
    CREATE KEYSPACE IF NOT EXISTS #{keyspace}
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    """

    Xandra.Cluster.execute(ChatService.Repo, create_keyspace_query)

    create_messages_table = """
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
    """

    create_conversations_table = """
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

    Xandra.Cluster.execute(ChatService.Repo, create_messages_table)
    Xandra.Cluster.execute(ChatService.Repo, create_conversations_table)

    :ok
  end
end

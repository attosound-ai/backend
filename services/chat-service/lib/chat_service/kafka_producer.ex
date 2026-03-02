defmodule ChatService.KafkaProducer do
  @moduledoc """
  GenServer-based Kafka producer using brod.

  Manages the brod client lifecycle and provides a simple interface
  for publishing events to Kafka topics.
  """

  use GenServer

  require Logger

  @client_id :chat_service_kafka_client
  @default_topic "message.sent"

  # Public API

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Produce a message to a Kafka topic.

  - topic: the Kafka topic name (e.g., "message.sent")
  - key: partition key (e.g., conversation_id for ordering)
  - value: the event payload (will be JSON-encoded)
  """
  def produce(topic \\ @default_topic, key, value) do
    GenServer.cast(__MODULE__, {:produce, topic, key, value})
  end

  # GenServer callbacks

  @impl true
  def init(opts) do
    brokers = Keyword.get(opts, :brokers, [{"localhost", 9092}])

    state = %{
      brokers: brokers,
      client_id: @client_id,
      connected: false
    }

    send(self(), :connect)
    {:ok, state}
  end

  @impl true
  def handle_info(:connect, state) do
    case start_brod_client(state.brokers, state.client_id) do
      :ok ->
        Logger.info("Kafka producer connected to #{inspect(state.brokers)}")
        {:noreply, %{state | connected: true}}

      {:error, reason} ->
        Logger.warning("Kafka producer connection failed: #{inspect(reason)}. Retrying in 5s...")
        Process.send_after(self(), :connect, 5_000)
        {:noreply, %{state | connected: false}}
    end
  end

  @impl true
  def handle_cast({:produce, topic, key, value}, %{connected: false} = state) do
    Logger.warning("Kafka not connected, dropping message for topic #{topic}")
    {:noreply, state}
  end

  def handle_cast({:produce, topic, key, value}, %{connected: true} = state) do
    encoded_value =
      case Jason.encode(value) do
        {:ok, json} -> json
        {:error, _} -> inspect(value)
      end

    key_str = if is_binary(key), do: key, else: to_string(key)

    case :brod.produce_sync(state.client_id, topic, :hash, key_str, encoded_value) do
      :ok ->
        Logger.debug("Published event to Kafka topic #{topic}")

      {:error, reason} ->
        Logger.error("Failed to publish to Kafka topic #{topic}: #{inspect(reason)}")
    end

    {:noreply, state}
  end

  @impl true
  def terminate(_reason, %{connected: true, client_id: client_id}) do
    :brod.stop_client(client_id)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  # Private functions

  defp start_brod_client(brokers, client_id) do
    client_config = [
      reconnect_cool_down_seconds: 5,
      auto_start_producers: true,
      default_producer_config: [
        required_acks: 1,
        max_retries: 3
      ]
    ]

    case :brod.start_client(brokers, client_id, client_config) do
      :ok -> :ok
      {:error, {:already_started, _pid}} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end
end

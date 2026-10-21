defmodule ChatService.KafkaConsumer do
  @moduledoc """
  GenServer-based Kafka consumer using brod.

  Subscribes to `interaction.created`, `interaction.removed`, and
  `notification.trigger` topics, then broadcasts events via Phoenix PubSub
  to `post:<content_id>` and `user:<recipient_id>` channels.
  """

  use GenServer

  require Logger

  @client_id :chat_service_kafka_consumer
  @group_id "chat-social-broadcast"
  @topics ["interaction.created", "interaction.removed", "notification.trigger", "user.deleted"]

  # Public API

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
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
    case start_consumer(state.brokers) do
      :ok ->
        Logger.info("Kafka consumer connected, subscribed to #{inspect(@topics)}")
        {:noreply, %{state | connected: true}}

      {:error, reason} ->
        Logger.warning(
          "Kafka consumer connection failed: #{inspect(reason)}. Retrying in 5s..."
        )

        Process.send_after(self(), :connect, 5_000)
        {:noreply, %{state | connected: false}}
    end
  end

  def handle_info({_consumer_pid, kafka_msg_set}, state) when is_tuple(kafka_msg_set) do
    # brod delivers messages as kafka_message_set or kafka_message tuples
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{connected: true}) do
    :brod.stop_client(@client_id)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  # Private

  defp start_consumer(brokers) do
    client_config = [reconnect_cool_down_seconds: 5]

    with :ok <- start_brod_client(brokers, client_config) do
      group_config = [
        offset_commit_policy: :commit_to_kafka_v2,
        offset_commit_interval_seconds: 5
      ]

      init_data = %{}

      case :brod.start_link_group_subscriber(
             @client_id,
             @group_id,
             @topics,
             group_config,
             _consumer_config = [begin_offset: :latest],
             _cb_module = __MODULE__.MessageHandler,
             _cb_init_data = init_data
           ) do
        {:ok, _pid} -> :ok
        {:error, reason} -> {:error, reason}
      end
    end
  end

  defp start_brod_client(brokers, client_config) do
    case :brod.start_client(brokers, @client_id, client_config) do
      :ok -> :ok
      {:error, {:already_started, _pid}} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end
end

defmodule ChatService.KafkaConsumer.MessageHandler do
  @moduledoc false
  @behaviour :brod_group_subscriber

  require Logger
  require Record

  Record.defrecord(:kafka_message, Record.extract(:kafka_message, from_lib: "brod/include/brod.hrl"))

  @impl true
  def init(_group_id, _init_data) do
    {:ok, %{}}
  end

  @impl true
  def handle_message(topic, _partition, message, state) do
    value = kafka_message(message, :value)

    case Jason.decode(value) do
      {:ok, payload} ->
        case topic do
          t when t in ["interaction.created", "interaction.removed"] ->
            action = if t == "interaction.created", do: "created", else: "removed"
            content_id = payload["content_id"]
            type = payload["type"]
            user_id = payload["user_id"]

            if content_id do
              ChatServiceWeb.Endpoint.broadcast("post:#{content_id}", "interaction_update", %{
                "type" => type,
                "action" => action,
                "user_id" => user_id,
                "content_id" => content_id
              })
            end

          "notification.trigger" ->
            recipient_id = payload["recipient_id"]
            type = payload["type"]
            actor_id = payload["actor_id"]

            if recipient_id do
              ChatServiceWeb.Endpoint.broadcast(
                "user:#{recipient_id}",
                "new_notification",
                %{"type" => type, "actor_id" => actor_id}
              )
            end

          "user.deleted" ->
            data = payload["data"] || payload
            user_ids = data["userIds"] || []
            Logger.info("Processing user.deleted for: #{inspect(user_ids)}")

            # brod forces us to ACK, so a failed cascade must NOT vanish silently:
            # retry briefly, then dead-letter (topic + table + Sentry) before ACK.
            Enum.each(user_ids, &process_user_deletion/1)

          _ ->
            nil
        end

      {:error, reason} ->
        Logger.warning("Failed to decode Kafka message on #{topic}: #{inspect(reason)}")
    end

    {:ok, :ack, state}
  end

  # --- user.deleted cascade with retry + dead-letter ---

  @max_inline_attempts 2
  @inline_backoff_ms 200

  defp process_user_deletion(user_id) do
    user_id = to_string(user_id)

    case attempt_delete(user_id, 1) do
      {:ok, summary} ->
        ChatService.Telemetry.Audit.log(:user_deletion_completed, summary)

      {:error, reason, partial} ->
        send_to_dlq(user_id, reason, partial)
    end
  end

  # One quick inline retry; serious retries are delegated to the DLQ reprocessor
  # so we never block this partition for long.
  defp attempt_delete(user_id, attempt) do
    case ChatService.Conversations.AccountDeletion.delete_all_for_user(user_id) do
      {:ok, summary} ->
        {:ok, summary}

      {:error, _reason, _partial} when attempt < @max_inline_attempts ->
        Process.sleep(@inline_backoff_ms)
        attempt_delete(user_id, attempt + 1)

      {:error, reason, partial} ->
        {:error, reason, partial}
    end
  end

  defp send_to_dlq(user_id, reason, partial) do
    Logger.error("user.deleted cascade failed for #{user_id}: #{inspect(reason)} — routing to DLQ")

    ChatService.KafkaProducer.produce("user.deleted.dlq", user_id, %{
      "userId" => user_id,
      "reason" => inspect(reason),
      "partial" => inspect(partial),
      "failed_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    })

    ChatService.Repo.execute_prepared(
      "INSERT INTO failed_deletions (user_id, reason, attempts, failed_at) VALUES (?, ?, ?, ?)",
      %{
        "user_id" => {"text", user_id},
        "reason" => {"text", inspect(reason)},
        "attempts" => {"int", @max_inline_attempts},
        "failed_at" => {"timestamp", DateTime.utc_now()}
      }
    )

    Sentry.capture_message("user.deleted chat cascade routed to DLQ",
      level: :error,
      extra: %{user_id: user_id, reason: inspect(reason)}
    )
  end
end

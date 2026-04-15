defmodule ChatService.Messages.EventPublisher do
  @moduledoc """
  Event publication contract for message mutations.

  Centralises the "fanout" step of a mutation: Phoenix.PubSub for same-node
  subscribers (WebSocket clients attached to this chat-service instance) and
  Kafka for cross-service consumers (notifications, search indexing, audit
  log, analytics). Abstracting both behind one call keeps `MessageService`
  agnostic of transport details (SOLID: Single Responsibility + Dependency
  Inversion) and lets future consumers extend fanout targets without touching
  the orchestrator.

  Only `publish_deleted/1` is defined for now — send/edit will migrate in a
  follow-up PR to avoid expanding this refactor's blast radius.
  """

  @type deleted_payload :: %{
          message_id: String.t(),
          conversation_id: String.t(),
          sender_id: String.t(),
          deleted_by: String.t(),
          deleted_at: DateTime.t(),
          is_deleted: true
        }

  @callback publish_deleted(payload :: deleted_payload()) :: :ok

  @spec publish_deleted(deleted_payload()) :: :ok
  def publish_deleted(payload) do
    impl().publish_deleted(payload)
  end

  defp impl do
    Application.get_env(
      :chat_service,
      :message_event_publisher,
      ChatService.Messages.EventPublisher.Default
    )
  end
end

defmodule ChatService.Messages.EventPublisher.Default do
  @moduledoc """
  Default `ChatService.Messages.EventPublisher` that fans out to Phoenix.PubSub
  and Kafka.

  Contract:
    * Phoenix.PubSub broadcast to `"chat:<conversation_id>"` as
      `{:message_deleted, payload}` — the existing `ChatChannel` consumes
      this and pushes `"message_deleted"` to clients.
    * Kafka topic `"message.deleted"` keyed by `conversation_id` so downstream
      consumers see strictly-ordered events per conversation.

  The Kafka payload wraps the mutation in the same envelope used by
  `"message.sent"` (`event`, `data`, `timestamp`) so consumers can share a
  codec. Datetimes are ISO-8601 to survive JSON encoding.
  """

  @behaviour ChatService.Messages.EventPublisher

  alias ChatService.KafkaProducer

  @kafka_topic "message.deleted"

  @impl true
  def publish_deleted(payload) do
    broadcast_to_pubsub(payload)
    publish_to_kafka(payload)
    :ok
  end

  defp broadcast_to_pubsub(payload) do
    Phoenix.PubSub.broadcast(
      ChatService.PubSub,
      "chat:#{payload.conversation_id}",
      {:message_deleted, serialize(payload)}
    )
  end

  defp publish_to_kafka(payload) do
    event = %{
      event: @kafka_topic,
      data: serialize(payload),
      timestamp: DateTime.to_iso8601(DateTime.utc_now())
    }

    KafkaProducer.produce(@kafka_topic, payload.conversation_id, event)
  end

  defp serialize(payload) do
    %{
      message_id: payload.message_id,
      conversation_id: payload.conversation_id,
      sender_id: payload.sender_id,
      deleted_by: payload.deleted_by,
      deleted_at: DateTime.to_iso8601(payload.deleted_at),
      is_deleted: true
    }
  end
end

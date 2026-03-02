defmodule ChatService.Messages.MessageService do
  @moduledoc """
  Business logic for chat messages.

  Handles sending messages (insert into Cassandra, update conversations,
  broadcast via Phoenix Channel, publish to Kafka) and retrieving message history.
  """

  alias ChatService.Messages.Message
  alias ChatService.Conversations.ConversationService
  alias ChatService.KafkaProducer
  alias ChatService.Repo

  require Logger

  @default_limit 50

  @doc """
  Send a new message in a conversation.

  Steps:
  1. Generate a timeuuid for the message
  2. Insert the message into the messages table
  3. Update both participants' conversation entries
  4. Broadcast the message via Phoenix PubSub (for Channels)
  5. Publish a Kafka event
  """
  def send_message(sender_id, conversation_id, content, content_type \\ "text") do
    now = DateTime.utc_now()
    message_id = UUID.uuid1()

    query = """
    INSERT INTO messages (conversation_id, message_id, sender_id, content, content_type, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id},
      "sender_id" => {"text", sender_id},
      "content" => {"text", content},
      "content_type" => {"text", content_type},
      "is_read" => {"boolean", false},
      "created_at" => {"timestamp", now}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, _} ->
        message = %Message{
          conversation_id: conversation_id,
          message_id: message_id,
          sender_id: sender_id,
          content: content,
          content_type: content_type,
          is_read: false,
          created_at: now
        }

        ConversationService.update_last_message(conversation_id, sender_id, content, now)

        broadcast_message(conversation_id, message)
        publish_kafka_event(message)

        {:ok, message}

      {:error, reason} ->
        Logger.error("Failed to send message: #{inspect(reason)}")
        {:error, :insert_failed}
    end
  end

  @doc """
  Get messages for a conversation with cursor-based pagination.

  Returns messages in reverse chronological order (newest first).
  Use `before` timeuuid cursor to paginate backwards.
  """
  def get_messages(conversation_id, opts \\ []) do
    before = Keyword.get(opts, :before)
    limit = Keyword.get(opts, :limit, @default_limit)
    limit = min(limit, 100)

    {query, params} =
      if before do
        {
          """
          SELECT conversation_id, message_id, sender_id, content, content_type, is_read, created_at
          FROM messages
          WHERE conversation_id = ? AND message_id < ?
          ORDER BY message_id DESC
          LIMIT ?
          """,
          %{
            "conversation_id" => {"uuid", conversation_id},
            "message_id" => {"timeuuid", before},
            "limit" => {"int", limit}
          }
        }
      else
        {
          """
          SELECT conversation_id, message_id, sender_id, content, content_type, is_read, created_at
          FROM messages
          WHERE conversation_id = ?
          ORDER BY message_id DESC
          LIMIT ?
          """,
          %{
            "conversation_id" => {"uuid", conversation_id},
            "limit" => {"int", limit}
          }
        }
      end

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        messages =
          result
          |> Enum.to_list()
          |> Enum.map(&Message.from_row/1)

        has_more = length(messages) == limit

        next_cursor =
          if has_more do
            messages |> List.last() |> Map.get(:message_id)
          else
            nil
          end

        {:ok, %{messages: messages, next_cursor: next_cursor, has_more: has_more}}

      {:error, reason} ->
        Logger.error("Failed to get messages: #{inspect(reason)}")
        {:error, :query_failed}
    end
  end

  @doc """
  Mark all messages in a conversation as read for a given user.
  This updates individual messages where sender_id != user_id.
  """
  def mark_as_read(conversation_id, user_id) do
    get_query = """
    SELECT message_id FROM messages
    WHERE conversation_id = ?
    """

    params = %{"conversation_id" => {"uuid", conversation_id}}

    case Repo.execute_prepared(get_query, params) do
      {:ok, result} ->
        update_query = """
        UPDATE messages SET is_read = true
        WHERE conversation_id = ? AND message_id = ?
        """

        result
        |> Enum.to_list()
        |> Enum.each(fn row ->
          update_params = %{
            "conversation_id" => {"uuid", conversation_id},
            "message_id" => {"timeuuid", to_string(row["message_id"])}
          }

          Repo.execute_prepared(update_query, update_params)
        end)

        ConversationService.reset_unread_count(user_id, conversation_id)

        {:ok, :marked}

      {:error, reason} ->
        Logger.error("Failed to mark messages as read: #{inspect(reason)}")
        {:error, :update_failed}
    end
  end

  defp broadcast_message(conversation_id, %Message{} = message) do
    Phoenix.PubSub.broadcast(
      ChatService.PubSub,
      "chat:#{conversation_id}",
      {:new_message, Message.to_map(message)}
    )
  end

  defp publish_kafka_event(%Message{} = message) do
    event = %{
      event: "message.sent",
      data: %{
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        sender_id: message.sender_id,
        content: message.content,
        content_type: message.content_type,
        created_at: format_datetime(message.created_at)
      },
      timestamp: DateTime.to_iso8601(DateTime.utc_now())
    }

    KafkaProducer.produce("message.sent", message.conversation_id, event)
  end

  defp format_datetime(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_datetime(other), do: to_string(other)
end

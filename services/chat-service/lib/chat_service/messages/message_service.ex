defmodule ChatService.Messages.MessageService do
  @moduledoc """
  Business logic for chat messages.

  Handles sending messages (insert into Cassandra, update conversations,
  broadcast via Phoenix Channel, publish to Kafka) and retrieving message history.
  """

  alias ChatService.Messages.Message
  alias ChatService.Conversations.ConversationService
  alias ChatService.Reactions.ReactionService
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
  def send_message(sender_id, conversation_id, content, content_type \\ "text", opts \\ []) do
    now = DateTime.utc_now()
    message_id = UUID.uuid1()
    reply_to_id = Keyword.get(opts, :reply_to_id)
    reply_to_content = Keyword.get(opts, :reply_to_content)
    reply_to_sender = Keyword.get(opts, :reply_to_sender)

    query = """
    INSERT INTO messages (conversation_id, message_id, sender_id, content, content_type, is_read, created_at, reply_to_id, reply_to_content, reply_to_sender)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id},
      "sender_id" => {"text", sender_id},
      "content" => {"text", content},
      "content_type" => {"text", content_type},
      "is_read" => {"boolean", false},
      "created_at" => {"timestamp", now},
      "reply_to_id" => {"text", reply_to_id || ""},
      "reply_to_content" => {"text", reply_to_content || ""},
      "reply_to_sender" => {"text", reply_to_sender || ""}
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
          reply_to_id: reply_to_id,
          reply_to_content: reply_to_content,
          reply_to_sender: reply_to_sender,
          created_at: now
        }

        ConversationService.update_last_message(conversation_id, sender_id, content, now)

        broadcast_message(conversation_id, message)
        recipient_id = Keyword.get(opts, :recipient_id)
        publish_kafka_event(message, recipient_id)

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
          SELECT * FROM messages
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
          SELECT * FROM messages
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

        # Load reactions for all messages in batch
        message_ids = Enum.map(messages, & &1.message_id)
        reactions_map =
          case ReactionService.get_reactions_batch(message_ids) do
            {:ok, map} -> map
            _ -> %{}
          end

        {:ok, %{messages: messages, reactions: reactions_map, next_cursor: next_cursor, has_more: has_more}}

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

  @doc """
  Edit a message's content. Only the original sender can edit.
  """
  def edit_message(message_id, conversation_id, sender_id, new_content) do
    # Verify sender owns the message
    case verify_sender(message_id, conversation_id, sender_id) do
      :ok ->
        now = DateTime.utc_now()

        query = """
        UPDATE messages
        SET content = ?, is_edited = true, edited_at = ?
        WHERE conversation_id = ? AND message_id = ?
        """

        params = %{
          "content" => {"text", new_content},
          "edited_at" => {"timestamp", now},
          "conversation_id" => {"uuid", conversation_id},
          "message_id" => {"timeuuid", message_id}
        }

        case Repo.execute_prepared(query, params) do
          {:ok, _} ->
            payload = %{
              message_id: message_id,
              conversation_id: conversation_id,
              sender_id: sender_id,
              content: new_content,
              is_edited: true,
              edited_at: DateTime.to_iso8601(now)
            }

            broadcast_event(conversation_id, :message_edited, payload)
            {:ok, payload}

          {:error, reason} ->
            Logger.error("Failed to edit message: #{inspect(reason)}")
            {:error, :update_failed}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Soft-delete a message. Only the original sender can delete.
  The message content is replaced with a tombstone; the row is preserved.
  """
  def delete_message(message_id, conversation_id, sender_id) do
    case verify_sender(message_id, conversation_id, sender_id) do
      :ok ->
        query = """
        UPDATE messages
        SET is_deleted = true, content = ''
        WHERE conversation_id = ? AND message_id = ?
        """

        params = %{
          "conversation_id" => {"uuid", conversation_id},
          "message_id" => {"timeuuid", message_id}
        }

        case Repo.execute_prepared(query, params) do
          {:ok, _} ->
            payload = %{
              message_id: message_id,
              conversation_id: conversation_id,
              sender_id: sender_id,
              is_deleted: true
            }

            broadcast_event(conversation_id, :message_deleted, payload)
            {:ok, payload}

          {:error, reason} ->
            Logger.error("Failed to delete message: #{inspect(reason)}")
            {:error, :update_failed}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp verify_sender(message_id, conversation_id, sender_id) do
    query = """
    SELECT sender_id FROM messages
    WHERE conversation_id = ? AND message_id = ?
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        row = result |> Enum.to_list() |> List.first()

        cond do
          is_nil(row) -> {:error, :not_found}
          to_string(row["sender_id"]) != sender_id -> {:error, :forbidden}
          true -> :ok
        end

      {:error, _} ->
        {:error, :query_failed}
    end
  end

  defp broadcast_event(conversation_id, event, payload) do
    Phoenix.PubSub.broadcast(
      ChatService.PubSub,
      "chat:#{conversation_id}",
      {event, payload}
    )
  end

  defp broadcast_message(conversation_id, %Message{} = message) do
    Phoenix.PubSub.broadcast(
      ChatService.PubSub,
      "chat:#{conversation_id}",
      {:new_message, Message.to_map(message)}
    )
  end

  defp publish_kafka_event(%Message{} = message, recipient_id \\ nil) do
    data =
      %{
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        sender_id: message.sender_id,
        content: message.content,
        content_type: message.content_type,
        created_at: format_datetime(message.created_at)
      }
      |> then(fn d ->
        if recipient_id, do: Map.put(d, :recipient_id, recipient_id), else: d
      end)

    event = %{
      event: "message.sent",
      data: data,
      timestamp: DateTime.to_iso8601(DateTime.utc_now())
    }

    KafkaProducer.produce("message.sent", message.conversation_id, event)
  end

  defp format_datetime(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_datetime(other), do: to_string(other)
end

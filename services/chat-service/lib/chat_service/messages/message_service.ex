defmodule ChatService.Messages.MessageService do
  @moduledoc """
  Business logic for chat messages.

  Handles sending messages (insert into Cassandra, update conversations,
  broadcast via Phoenix Channel, publish to Kafka) and retrieving message history.
  """

  alias ChatService.Messages.Message
  alias ChatService.Messages.Authorizer
  alias ChatService.Messages.Persistence
  alias ChatService.Messages.EventPublisher
  alias ChatService.Messages.ReactionCleaner
  alias ChatService.Messages.ThreadInbox
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
    metadata = Keyword.get(opts, :metadata)
    thread_id = Keyword.get(opts, :thread_id)

    query = """
    INSERT INTO messages (conversation_id, message_id, sender_id, content, content_type, is_read, created_at, reply_to_id, reply_to_content, reply_to_sender, metadata, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      "reply_to_sender" => {"text", reply_to_sender || ""},
      "metadata" => {"text", Message.encode_metadata(metadata)},
      "thread_id" => {"text", thread_id || ""}
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
          metadata: Message.decode_metadata(metadata),
          thread_id: thread_id,
          created_at: now
        }

        if thread_id do
          index_thread_message(conversation_id, thread_id, message_id, now)
          # The inbox row is written after the index so its reply count, which
          # is counted rather than incremented, already sees this reply.
          ThreadInbox.index_reply(
            conversation_id,
            thread_id,
            sender_id,
            root_preview(conversation_id, thread_id),
            preview_for(content, content_type, nil),
            now
          )
        end

        # Media messages carry JSON in `content`; the list shows a type label.
        ConversationService.update_last_message(
          conversation_id,
          sender_id,
          preview_for(content, content_type, thread_id),
          now
        )

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
  Soft-delete a message.

  Orchestrates an authorize → persist → cascade → publish pipeline built
  from swappable collaborators (`Authorizer`, `Persistence`, `EventPublisher`).
  Each collaborator owns exactly one concern:

    1. `Authorizer.can_delete?/3` — decides whether `user_id` may delete
       the message. Only the original sender today; moderator and retention
       policies can be added as new implementations (Open/Closed).
    2. `Persistence.soft_delete/3` — writes the tombstone row and stamps
       audit fields (`deleted_at`, `deleted_by`). Returns the DB-side
       timestamp so the emitted payload matches the persisted state.
    3. `ReactionService.delete_all_for_message/2` — cascades reaction
       cleanup so the deleted message has no stale UI state. Failures are
       logged but non-fatal because the parent mutation already committed.
    4. `EventPublisher.publish_deleted/1` — fans out to Phoenix.PubSub for
       in-node WebSocket subscribers and to Kafka (`message.deleted` topic)
       for cross-service consumers (notifications, search, audit).

  Any error short-circuits the pipeline via `with/1` and bubbles a specific
  atom (`:forbidden`, `:not_found`, `:update_failed`, …) so upstream
  controllers/channels can translate to HTTP/WS errors without inspecting
  driver internals.
  """
  def delete_message(message_id, conversation_id, user_id) do
    with :ok <- Authorizer.can_delete?(message_id, conversation_id, user_id),
         {:ok, deleted_at} <- Persistence.soft_delete(message_id, conversation_id, user_id),
         :ok <- ReactionCleaner.cleanup(message_id, conversation_id) do
      payload = %{
        message_id: message_id,
        conversation_id: conversation_id,
        sender_id: user_id,
        deleted_by: user_id,
        deleted_at: deleted_at,
        is_deleted: true
      }

      :ok = EventPublisher.publish_deleted(payload)
      {:ok, payload}
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

  @doc """
  One message by id.
  """
  def get_message(conversation_id, message_id) do
    query = "SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?"

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, page} ->
        case Enum.to_list(page) do
          [row | _] -> {:ok, Message.from_row(row)}
          [] -> {:error, :not_found}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Messages of one thread (Slack style), oldest first, including the root.
  """
  def get_thread_messages(conversation_id, thread_id) do
    query = """
    SELECT message_id FROM thread_messages WHERE conversation_id = ? AND thread_id = ?
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "thread_id" => {"text", thread_id}
    }

    with {:ok, page} <- Repo.execute_prepared(query, params) do
      ids = [thread_id | Enum.map(page, & to_string(&1["message_id"]))] |> Enum.uniq()

      messages =
        ids
        |> Enum.map(fn id -> get_message(conversation_id, id) end)
        |> Enum.flat_map(fn
          {:ok, msg} -> [msg]
          _ -> []
        end)
        |> Enum.sort_by(& &1.created_at, {:asc, DateTime})

      {:ok, messages}
    end
  end

  @doc """
  Pin a message in a conversation (Telegram and WhatsApp keep a bar with it
  under the header). Both participants of a private chat may pin, and the
  pinned set lives in its own table so the bar costs one small read.
  """
  def pin_message(conversation_id, message_id, user_id) do
    now = DateTime.utc_now()

    insert = """
    INSERT INTO pinned_messages (conversation_id, message_id, pinned_by, pinned_at)
    VALUES (?, ?, ?, ?)
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id},
      "pinned_by" => {"text", to_string(user_id)},
      "pinned_at" => {"timestamp", now}
    }

    with {:ok, _} <- Repo.execute_prepared(insert, params),
         {:ok, message} <- get_message(conversation_id, message_id) do
      payload = %{
        conversation_id: conversation_id,
        message_id: message_id,
        pinned_by: to_string(user_id),
        pinned_at: DateTime.to_iso8601(now),
        message: Message.to_map(message)
      }

      broadcast_event(conversation_id, :message_pinned, payload)
      {:ok, payload}
    end
  end

  @doc """
  Remove a message from the pinned set.
  """
  def unpin_message(conversation_id, message_id, user_id) do
    query = """
    DELETE FROM pinned_messages WHERE conversation_id = ? AND message_id = ?
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id}
    }

    with {:ok, _} <- Repo.execute_prepared(query, params) do
      payload = %{
        conversation_id: conversation_id,
        message_id: message_id,
        unpinned_by: to_string(user_id)
      }

      broadcast_event(conversation_id, :message_unpinned, payload)
      {:ok, payload}
    end
  end

  @doc """
  Every pinned message of a conversation, newest first. Rows whose message is
  gone (deleted for everyone) are dropped, so the bar never points nowhere.
  """
  def get_pinned_messages(conversation_id) do
    query = """
    SELECT message_id, pinned_by, pinned_at FROM pinned_messages
    WHERE conversation_id = ?
    """

    params = %{"conversation_id" => {"uuid", conversation_id}}

    with {:ok, page} <- Repo.execute_prepared(query, params) do
      messages =
        page
        |> Enum.to_list()
        |> Enum.map(&to_string(&1["message_id"]))
        |> Enum.flat_map(fn id ->
          case get_message(conversation_id, id) do
            {:ok, %Message{is_deleted: true}} -> []
            {:ok, msg} -> [msg]
            _ -> []
          end
        end)
        |> Enum.sort_by(& &1.created_at, {:desc, DateTime})

      {:ok, messages}
    end
  end

  defp index_thread_message(conversation_id, thread_id, message_id, now) do
    query = """
    INSERT INTO thread_messages (conversation_id, thread_id, message_id, created_at)
    VALUES (?, ?, ?, ?)
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "thread_id" => {"text", thread_id},
      "message_id" => {"timeuuid", message_id},
      "created_at" => {"timestamp", now}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, _} -> :ok
      {:error, reason} -> Logger.error("thread index failed: #{inspect(reason)}")
    end
  end

  # The first line of the message that started the thread, for the inbox row.
  defp root_preview(conversation_id, thread_id) do
    case get_message(conversation_id, thread_id) do
      {:ok, message} -> preview_for(message.content, message.content_type, nil)
      _ -> ""
    end
  end

  defp preview_for(content, "text", nil), do: content
  defp preview_for(content, "text", _thread), do: "[thread] " <> content
  defp preview_for(_content, content_type, _thread), do: "[" <> content_type <> "]"
end

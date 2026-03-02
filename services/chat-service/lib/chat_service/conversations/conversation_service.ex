defmodule ChatService.Conversations.ConversationService do
  @moduledoc """
  Business logic for conversations.

  Manages the denormalized conversations table which provides each user
  with a fast-loading list of their conversations, ordered by most recent activity.
  """

  alias ChatService.Conversations.Conversation
  alias ChatService.Repo

  require Logger

  @doc """
  List all conversations for a given user, ordered by most recent activity.
  """
  def list_conversations(user_id) do
    query = """
    SELECT user_id, conversation_id, participant_id, participant_name,
           last_message, last_message_at, unread_count, updated_at
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC
    """

    params = %{"user_id" => {"text", user_id}}

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        conversations =
          result
          |> Enum.to_list()
          |> Enum.map(&Conversation.from_row/1)

        {:ok, conversations}

      {:error, reason} ->
        Logger.error("Failed to list conversations: #{inspect(reason)}")
        {:error, :query_failed}
    end
  end

  @doc """
  Get or create a conversation between two users.
  Returns the conversation_id.
  """
  def get_or_create_conversation(user_id, participant_id, participant_name \\ nil) do
    query = """
    SELECT conversation_id, updated_at FROM conversations
    WHERE user_id = ?
    """

    params = %{"user_id" => {"text", user_id}}

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        existing =
          result
          |> Enum.to_list()
          |> Enum.find(fn row ->
            to_string(row["participant_id"]) == participant_id
          end)

        if existing do
          {:ok, to_string(existing["conversation_id"])}
        else
          create_conversation(user_id, participant_id, participant_name)
        end

      {:error, _reason} ->
        create_conversation(user_id, participant_id, participant_name)
    end
  end

  @doc """
  Update the last_message and updated_at for both participants in a conversation.
  Also increments unread_count for the recipient.
  """
  def update_last_message(conversation_id, sender_id, content, timestamp) do
    find_query = """
    SELECT user_id, conversation_id, participant_id, participant_name, unread_count, updated_at
    FROM conversations
    WHERE user_id = ?
    ALLOW FILTERING
    """

    update_conversation_for_participants(conversation_id, sender_id, content, timestamp, find_query)
  end

  @doc """
  Reset unread count for a user's conversation.
  Since we need to delete and re-insert (Cassandra clustering key includes updated_at),
  we find the existing row first.
  """
  def reset_unread_count(user_id, conversation_id) do
    find_query = """
    SELECT user_id, conversation_id, participant_id, participant_name,
           last_message, last_message_at, unread_count, updated_at
    FROM conversations
    WHERE user_id = ?
    """

    params = %{"user_id" => {"text", user_id}}

    case Repo.execute_prepared(find_query, params) do
      {:ok, result} ->
        result
        |> Enum.to_list()
        |> Enum.find(fn row -> to_string(row["conversation_id"]) == conversation_id end)
        |> case do
          nil ->
            :ok

          row ->
            old_updated_at = row["updated_at"]

            delete_query = """
            DELETE FROM conversations
            WHERE user_id = ? AND updated_at = ? AND conversation_id = ?
            """

            delete_params = %{
              "user_id" => {"text", user_id},
              "updated_at" => {"timestamp", old_updated_at},
              "conversation_id" => {"uuid", conversation_id}
            }

            Repo.execute_prepared(delete_query, delete_params)

            insert_query = """
            INSERT INTO conversations (user_id, conversation_id, participant_id, participant_name,
                                       last_message, last_message_at, unread_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """

            insert_params = %{
              "user_id" => {"text", user_id},
              "conversation_id" => {"uuid", conversation_id},
              "participant_id" => {"text", to_string(row["participant_id"])},
              "participant_name" => {"text", row["participant_name"] || ""},
              "last_message" => {"text", row["last_message"] || ""},
              "last_message_at" => {"timestamp", row["last_message_at"] || old_updated_at},
              "unread_count" => {"int", 0},
              "updated_at" => {"timestamp", old_updated_at}
            }

            Repo.execute_prepared(insert_query, insert_params)
        end

        :ok

      {:error, reason} ->
        Logger.error("Failed to reset unread count: #{inspect(reason)}")
        {:error, :update_failed}
    end
  end

  @doc """
  Get the total unread message count across all conversations for a user.
  """
  def get_total_unread(user_id) do
    query = """
    SELECT unread_count FROM conversations
    WHERE user_id = ?
    """

    params = %{"user_id" => {"text", user_id}}

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        total =
          result
          |> Enum.to_list()
          |> Enum.reduce(0, fn row, acc -> acc + (row["unread_count"] || 0) end)

        {:ok, total}

      {:error, reason} ->
        Logger.error("Failed to get unread count: #{inspect(reason)}")
        {:error, :query_failed}
    end
  end

  @doc """
  Find a conversation by conversation_id for a specific user.
  """
  def find_conversation(user_id, conversation_id) do
    query = """
    SELECT user_id, conversation_id, participant_id, participant_name,
           last_message, last_message_at, unread_count, updated_at
    FROM conversations
    WHERE user_id = ?
    """

    params = %{"user_id" => {"text", user_id}}

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        result
        |> Enum.to_list()
        |> Enum.find(fn row -> to_string(row["conversation_id"]) == conversation_id end)
        |> case do
          nil -> {:error, :not_found}
          row -> {:ok, Conversation.from_row(row)}
        end

      {:error, reason} ->
        Logger.error("Failed to find conversation: #{inspect(reason)}")
        {:error, :query_failed}
    end
  end

  # Private functions

  defp create_conversation(user_id, participant_id, participant_name) do
    conversation_id = UUID.uuid4()
    now = DateTime.utc_now()

    insert_query = """
    INSERT INTO conversations (user_id, conversation_id, participant_id, participant_name,
                               last_message, last_message_at, unread_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """

    sender_params = %{
      "user_id" => {"text", user_id},
      "conversation_id" => {"uuid", conversation_id},
      "participant_id" => {"text", participant_id},
      "participant_name" => {"text", participant_name || ""},
      "last_message" => {"text", ""},
      "last_message_at" => {"timestamp", now},
      "unread_count" => {"int", 0},
      "updated_at" => {"timestamp", now}
    }

    recipient_params = %{
      "user_id" => {"text", participant_id},
      "conversation_id" => {"uuid", conversation_id},
      "participant_id" => {"text", user_id},
      "participant_name" => {"text", ""},
      "last_message" => {"text", ""},
      "last_message_at" => {"timestamp", now},
      "unread_count" => {"int", 0},
      "updated_at" => {"timestamp", now}
    }

    with {:ok, _} <- Repo.execute_prepared(insert_query, sender_params),
         {:ok, _} <- Repo.execute_prepared(insert_query, recipient_params) do
      {:ok, conversation_id}
    else
      {:error, reason} ->
        Logger.error("Failed to create conversation: #{inspect(reason)}")
        {:error, :insert_failed}
    end
  end

  defp update_conversation_for_participants(conversation_id, sender_id, content, timestamp, _find_query) do
    # We need to find all conversation entries referencing this conversation_id
    # for both the sender and recipient, then update them.
    # Since Cassandra's partition key is user_id, we need to know both user IDs.
    # We search the sender's conversations to find the participant_id.

    sender_query = """
    SELECT user_id, conversation_id, participant_id, participant_name, unread_count, updated_at
    FROM conversations
    WHERE user_id = ?
    """

    sender_params = %{"user_id" => {"text", sender_id}}

    case Repo.execute_prepared(sender_query, sender_params) do
      {:ok, result} ->
        sender_row =
          result
          |> Enum.to_list()
          |> Enum.find(fn row -> to_string(row["conversation_id"]) == conversation_id end)

        if sender_row do
          participant_id = to_string(sender_row["participant_id"])

          # Update sender's conversation entry (delete old, insert new with updated timestamp)
          update_single_conversation(
            sender_id,
            conversation_id,
            to_string(sender_row["participant_id"]),
            sender_row["participant_name"] || "",
            content,
            timestamp,
            sender_row["updated_at"],
            0  # Sender's unread stays at current or 0
          )

          # Update recipient's conversation entry
          recipient_query = """
          SELECT user_id, conversation_id, participant_id, participant_name, unread_count, updated_at
          FROM conversations
          WHERE user_id = ?
          """

          recipient_params = %{"user_id" => {"text", participant_id}}

          case Repo.execute_prepared(recipient_query, recipient_params) do
            {:ok, recipient_result} ->
              recipient_row =
                recipient_result
                |> Enum.to_list()
                |> Enum.find(fn row -> to_string(row["conversation_id"]) == conversation_id end)

              if recipient_row do
                current_unread = recipient_row["unread_count"] || 0

                update_single_conversation(
                  participant_id,
                  conversation_id,
                  sender_id,
                  recipient_row["participant_name"] || "",
                  content,
                  timestamp,
                  recipient_row["updated_at"],
                  current_unread + 1
                )
              end

            {:error, reason} ->
              Logger.error("Failed to update recipient conversation: #{inspect(reason)}")
          end
        end

        :ok

      {:error, reason} ->
        Logger.error("Failed to update sender conversation: #{inspect(reason)}")
        {:error, :update_failed}
    end
  end

  defp update_single_conversation(user_id, conversation_id, participant_id, participant_name, content, timestamp, old_updated_at, unread_count) do
    # Delete old entry (since updated_at is part of the clustering key)
    if old_updated_at do
      delete_query = """
      DELETE FROM conversations
      WHERE user_id = ? AND updated_at = ? AND conversation_id = ?
      """

      delete_params = %{
        "user_id" => {"text", user_id},
        "updated_at" => {"timestamp", old_updated_at},
        "conversation_id" => {"uuid", conversation_id}
      }

      Repo.execute_prepared(delete_query, delete_params)
    end

    # Insert new entry with updated timestamp
    insert_query = """
    INSERT INTO conversations (user_id, conversation_id, participant_id, participant_name,
                               last_message, last_message_at, unread_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """

    insert_params = %{
      "user_id" => {"text", user_id},
      "conversation_id" => {"uuid", conversation_id},
      "participant_id" => {"text", participant_id},
      "participant_name" => {"text", participant_name},
      "last_message" => {"text", content},
      "last_message_at" => {"timestamp", timestamp},
      "unread_count" => {"int", unread_count},
      "updated_at" => {"timestamp", timestamp}
    }

    Repo.execute_prepared(insert_query, insert_params)
  end
end

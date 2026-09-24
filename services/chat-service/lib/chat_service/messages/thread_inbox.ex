defmodule ChatService.Messages.ThreadInbox do
  @moduledoc """
  The threads inbox: every thread a user takes part in, across conversations,
  with how many replies they have not read yet and whether they follow it.

  Slack keeps a "Threads" entry above the channel list that gathers the
  threads you started, replied to or chose to follow, each with its own unread
  count. Before this module the app kept both facts on the device (MMKV), so
  the count reset on reinstall and never crossed devices.

  Two tables, both keyed by the pair (user, thread), so a read costs one
  partition per user and a write is a plain upsert with no clustering key to
  rewrite:

    * `threads_by_user`, one row per thread the user takes part in, carrying
      what the inbox row needs to draw itself without touching `messages`.
    * `thread_state`, how many replies the user has read and whether they
      follow the thread. Unread is `reply_count - read_count`, never negative.

  Membership grows on its own: sending the reply adds the sender, and the root
  author is added with it, which is exactly who Slack lists.
  """

  alias ChatService.Conversations.ConversationService
  alias ChatService.Repo

  require Logger

  @doc """
  Record a threaded reply for both sides of the conversation.

  `reply_count` is counted from `thread_messages` rather than incremented, so
  two replies landing at once can never leave the two rows disagreeing.
  Called from `MessageService.send_message/5` after the message is written.
  """
  def index_reply(conversation_id, thread_id, sender_id, root_preview, reply_preview, now) do
    reply_count = count_replies(conversation_id, thread_id)

    case ConversationService.find_conversation(sender_id, conversation_id) do
      {:ok, conversation} ->
        other_id = to_string(conversation.participant_id)
        other_name = conversation.participant_name || ""

        sender_name =
          case ConversationService.find_conversation(other_id, conversation_id) do
            {:ok, mirror} -> mirror.participant_name || ""
            _ -> ""
          end

        # Each side's row names the OTHER person, the way the inbox reads it.
        row = %{
          conversation_id: conversation_id,
          root_preview: root_preview,
          reply_preview: reply_preview,
          reply_count: reply_count,
          last_reply_at: now,
          last_reply_sender_id: sender_id
        }

        upsert_row(sender_id, thread_id, Map.merge(row, %{participant_id: other_id, participant_name: other_name}))
        upsert_row(other_id, thread_id, Map.merge(row, %{participant_id: sender_id, participant_name: sender_name}))

        # Replying follows the thread, as in Slack. The reader's own reply is
        # never unread, so the sender's read mark moves with it.
        set_following(sender_id, thread_id, true)
        mark_read(sender_id, thread_id, reply_count)
        :ok

      {:error, reason} ->
        Logger.error("Thread inbox: conversation #{conversation_id} not found: #{inspect(reason)}")
        :ok
    end
  end

  @doc """
  Every thread this user takes part in, newest reply first, each with its
  unread count and follow flag. Unfollowed threads stay in the list, as Slack
  keeps them until they fall off the end, but they never carry an unread.
  """
  def list(user_id) do
    query = """
    SELECT user_id, thread_id, conversation_id, participant_id, participant_name,
           root_preview, reply_preview, reply_count, last_reply_at, last_reply_sender_id
    FROM threads_by_user WHERE user_id = ?
    """

    with {:ok, rows} <- Repo.execute_prepared(query, %{"user_id" => {"text", to_string(user_id)}}) do
      state = state_map(user_id)

      threads =
        rows
        |> Enum.to_list()
        |> Enum.map(fn row ->
          thread_id = to_string(row["thread_id"])
          {read_count, following} = Map.get(state, thread_id, {0, true})
          reply_count = row["reply_count"] || 0

          %{
            thread_id: thread_id,
            conversation_id: to_string(row["conversation_id"]),
            participant_id: to_string(row["participant_id"] || ""),
            participant_name: row["participant_name"] || "",
            root_preview: row["root_preview"] || "",
            reply_preview: row["reply_preview"] || "",
            last_reply_sender_id: to_string(row["last_reply_sender_id"] || ""),
            reply_count: reply_count,
            unread: if(following, do: max(reply_count - read_count, 0), else: 0),
            following: following,
            last_reply_at: row["last_reply_at"]
          }
        end)
        |> Enum.sort_by(& &1.last_reply_at, {:desc, DateTime})

      {:ok, threads}
    end
  end

  @doc """
  Mark the thread read up to its current reply count. With no count given it
  is read from `thread_messages`, so the caller does not have to know it.
  """
  def mark_read(user_id, thread_id, read_count) when is_integer(read_count) do
    write_state(user_id, thread_id, read_count: read_count)
  end

  def mark_read(user_id, thread_id, conversation_id) do
    mark_read(user_id, thread_id, count_replies(conversation_id, thread_id))
  end

  @doc "Follow or unfollow a thread. Unfollowing silences its unread count."
  def set_following(user_id, thread_id, following) do
    write_state(user_id, thread_id, following: following)
  end

  # Private ------------------------------------------------------------------

  defp count_replies(conversation_id, thread_id) do
    query = "SELECT COUNT(*) AS count FROM thread_messages WHERE conversation_id = ? AND thread_id = ?"

    params = %{
      "conversation_id" => {"uuid", to_string(conversation_id)},
      "thread_id" => {"text", to_string(thread_id)}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, page} ->
        case Enum.to_list(page) do
          [row | _] -> row["count"] || 0
          _ -> 0
        end

      {:error, reason} ->
        Logger.error("Thread inbox: count failed: #{inspect(reason)}")
        0
    end
  end

  defp upsert_row(user_id, thread_id, row) do
    query = """
    INSERT INTO threads_by_user (user_id, thread_id, conversation_id, participant_id,
      participant_name, root_preview, reply_preview, reply_count, last_reply_at,
      last_reply_sender_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """

    params = %{
      "user_id" => {"text", to_string(user_id)},
      "thread_id" => {"text", to_string(thread_id)},
      "conversation_id" => {"uuid", to_string(row.conversation_id)},
      "participant_id" => {"text", to_string(row.participant_id)},
      "participant_name" => {"text", row.participant_name || ""},
      "root_preview" => {"text", row.root_preview || ""},
      "reply_preview" => {"text", row.reply_preview || ""},
      "reply_count" => {"int", row.reply_count},
      "last_reply_at" => {"timestamp", row.last_reply_at},
      "last_reply_sender_id" => {"text", to_string(row.last_reply_sender_id)}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, _} -> :ok
      {:error, reason} -> Logger.error("Thread inbox: upsert failed: #{inspect(reason)}")
    end
  end

  # Only the named columns are written, so marking read never clears the
  # follow flag and unfollowing never rewinds the read mark.
  defp write_state(user_id, thread_id, fields) do
    {columns, params} =
      Enum.reduce(fields, {[], %{}}, fn
        {:read_count, value}, {cols, acc} ->
          {["read_count" | cols], Map.put(acc, "read_count", {"int", value})}

        {:following, value}, {cols, acc} ->
          {["following" | cols], Map.put(acc, "following", {"boolean", value})}
      end)

    columns = ["user_id", "thread_id" | columns] ++ ["updated_at"]

    params =
      params
      |> Map.put("user_id", {"text", to_string(user_id)})
      |> Map.put("thread_id", {"text", to_string(thread_id)})
      |> Map.put("updated_at", {"timestamp", DateTime.utc_now()})

    placeholders = Enum.map_join(columns, ", ", fn _ -> "?" end)
    query = "INSERT INTO thread_state (#{Enum.join(columns, ", ")}) VALUES (#{placeholders})"

    case Repo.execute_prepared(query, params) do
      {:ok, _} -> :ok
      {:error, reason} -> Logger.error("Thread inbox: state write failed: #{inspect(reason)}")
    end
  end

  defp state_map(user_id) do
    query = "SELECT thread_id, read_count, following FROM thread_state WHERE user_id = ?"

    case Repo.execute_prepared(query, %{"user_id" => {"text", to_string(user_id)}}) do
      {:ok, rows} ->
        rows
        |> Enum.to_list()
        |> Map.new(fn row ->
          following = if is_nil(row["following"]), do: true, else: row["following"]
          {to_string(row["thread_id"]), {row["read_count"] || 0, following}}
        end)

      {:error, reason} ->
        Logger.error("Thread inbox: state read failed: #{inspect(reason)}")
        %{}
    end
  end
end

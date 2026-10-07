defmodule ChatService.Messages.ConversationPreview do
  @moduledoc """
  What the conversation list says after a message is deleted.

  The list of each participant stores the text of the last message. When that
  very message is deleted the list kept showing it (owner, Oct 7 2026: it
  should read "This message was deleted", the way WhatsApp does). This step
  replaces the stored preview: "You deleted this message" in the row of
  whoever deleted it and "This message was deleted" in the other person's.

  The stored text is a full English sentence and not a `[deleted]` style
  marker on purpose. The apps that know these two sentences show them in the
  person's own language; the builds released before that show whatever is
  stored as it comes, and a plain sentence reads right there while a raw
  marker would look broken.

  Nothing else about the conversation moves: its place in the list, its time
  and its unread count stay as they were. Deleting an older message changes
  nothing here.

  The step never fails the deletion. The message is already gone when it
  runs; a list that still shows the old text is a smaller problem than a
  delete that reports an error after it has happened.
  """

  # The apps match these two strings exactly (front: messagePreview.ts).
  # Changing a character here needs the same change there.
  @deleted "🚫 This message was deleted"
  @deleted_own "🚫 You deleted this message"

  @callback message_deleted(
              message_id :: String.t(),
              conversation_id :: String.t(),
              deleted_by :: String.t()
            ) :: :ok

  @spec message_deleted(String.t(), String.t(), String.t()) :: :ok
  def message_deleted(message_id, conversation_id, deleted_by) do
    impl().message_deleted(message_id, conversation_id, deleted_by)
  end

  @doc """
  The preview stored in one participant's row: their own wording when they
  are the one who deleted the message.
  """
  @spec preview_for(String.t() | integer(), String.t() | integer()) :: String.t()
  def preview_for(row_user_id, deleted_by) do
    if to_string(row_user_id) == to_string(deleted_by), do: @deleted_own, else: @deleted
  end

  @doc """
  Whether the deleted message is the one the list is showing: the newest of
  the conversation. Ids are compared without regard to letter case, since a
  timeuuid can come back from the driver in either.
  """
  @spec last_message?(String.t() | nil, String.t() | nil) :: boolean()
  def last_message?(nil, _deleted_id), do: false
  def last_message?(_latest_id, nil), do: false

  def last_message?(latest_id, deleted_id) do
    String.downcase(to_string(latest_id)) == String.downcase(to_string(deleted_id))
  end

  defp impl do
    Application.get_env(
      :chat_service,
      :message_conversation_preview,
      ChatService.Messages.ConversationPreview.Default
    )
  end
end

defmodule ChatService.Messages.ConversationPreview.Default do
  @moduledoc """
  Default `ChatService.Messages.ConversationPreview`: Cassandra for the rows
  and the user channels for the phones.

  The phones are told with `conversation_preview_changed`, a new event, and
  not with `conversation_updated`: that one means "a message arrived" and the
  apps answer it with a banner and an unread badge.
  """

  @behaviour ChatService.Messages.ConversationPreview

  alias ChatService.Conversations.ConversationService
  alias ChatService.Messages.ConversationPreview
  alias ChatService.Repo

  require Logger

  @impl true
  def message_deleted(message_id, conversation_id, deleted_by) do
    try do
      if ConversationPreview.last_message?(latest_message_id(conversation_id), message_id) do
        conversation_id
        |> ConversationService.replace_last_message(deleted_by, fn user_id ->
          ConversationPreview.preview_for(user_id, deleted_by)
        end)
        |> Enum.each(fn {user_id, preview} ->
          ChatServiceWeb.Endpoint.broadcast(
            "user:#{user_id}",
            "conversation_preview_changed",
            %{conversation_id: conversation_id, last_message: preview}
          )
        end)
      end
    rescue
      error ->
        Logger.error("Conversation preview after delete failed: #{inspect(error)}")
    catch
      kind, reason ->
        Logger.error("Conversation preview after delete failed: #{inspect({kind, reason})}")
    end

    :ok
  end

  defp latest_message_id(conversation_id) do
    query = """
    SELECT message_id FROM messages
    WHERE conversation_id = ?
    ORDER BY message_id DESC
    LIMIT 1
    """

    case Repo.execute_prepared(query, %{"conversation_id" => {"uuid", conversation_id}}) do
      {:ok, result} ->
        case result |> Enum.to_list() |> List.first() do
          nil -> nil
          row -> to_string(row["message_id"])
        end

      {:error, reason} ->
        Logger.error("Latest message lookup failed: #{inspect(reason)}")
        nil
    end
  end
end

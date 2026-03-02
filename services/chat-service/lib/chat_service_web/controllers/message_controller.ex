defmodule ChatServiceWeb.MessageController do
  use Phoenix.Controller, formats: [:json]
  require Logger

  alias ChatService.Messages.MessageService

  action_fallback ChatServiceWeb.FallbackController

  @doc """
  GET /api/v1/messages/:chat_id
  Retrieves paginated messages for a conversation.

  Query params:
    - before: timeuuid cursor for pagination
    - limit: max number of messages (default 50, max 100)
  """
  def index(conn, %{"chat_id" => chat_id} = params) do
    opts =
      []
      |> maybe_add_before(params)
      |> maybe_add_limit(params)

    case MessageService.get_messages(chat_id, opts) do
      {:ok, %{messages: messages, next_cursor: next_cursor, has_more: has_more}} ->
        conn
        |> put_status(200)
        |> put_view(ChatServiceWeb.MessageView)
        |> render("index.json",
          messages: messages,
          next_cursor: next_cursor,
          has_more: has_more
        )

      {:error, reason} ->
        Logger.error("Failed to get messages for chat #{chat_id}: #{inspect(reason)}")

        conn
        |> put_status(500)
        |> json(%{success: false, data: nil, error: "Failed to retrieve messages"})
    end
  end

  @doc """
  POST /api/v1/messages
  Send a new message.

  Body:
    - conversationId: UUID of the conversation
    - content: message text
    - contentType: "text" (default), "image", etc.
  """
  def create(conn, params) do
    user_id = conn.assigns.user_id
    conversation_id = params["conversationId"]
    content = params["content"]
    content_type = params["contentType"] || "text"

    cond do
      is_nil(conversation_id) || conversation_id == "" ->
        conn
        |> put_status(400)
        |> json(%{success: false, data: nil, error: "conversationId is required"})

      is_nil(content) || content == "" ->
        conn
        |> put_status(400)
        |> json(%{success: false, data: nil, error: "content is required"})

      true ->
        case MessageService.send_message(user_id, conversation_id, content, content_type) do
          {:ok, message} ->
            conn
            |> put_status(201)
            |> put_view(ChatServiceWeb.MessageView)
            |> render("show.json", message: message)

          {:error, reason} ->
            Logger.error("Failed to send message for user #{user_id}: #{inspect(reason)}")

            conn
            |> put_status(500)
            |> json(%{success: false, data: nil, error: "Failed to send message"})
        end
    end
  end

  defp maybe_add_before(opts, %{"before" => before}) when is_binary(before) and before != "" do
    Keyword.put(opts, :before, before)
  end

  defp maybe_add_before(opts, _params), do: opts

  defp maybe_add_limit(opts, %{"limit" => limit}) when is_binary(limit) do
    case Integer.parse(limit) do
      {n, _} when n > 0 -> Keyword.put(opts, :limit, n)
      _ -> opts
    end
  end

  defp maybe_add_limit(opts, _params), do: opts
end

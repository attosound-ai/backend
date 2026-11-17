defmodule ChatServiceWeb.ConversationController do
  use Phoenix.Controller, formats: [:json]
  require Logger

  alias ChatService.Conversations.ConversationService
  alias ChatService.Messages.ThreadInbox

  action_fallback ChatServiceWeb.FallbackController

  @doc """
  GET /api/v1/messages/conversations
  Lists all conversations for the authenticated user.
  """
  def index(conn, _params) do
    user_id = conn.assigns.user_id

    case ConversationService.list_conversations(user_id) do
      {:ok, conversations} ->
        conn
        |> put_status(200)
        |> put_view(ChatServiceWeb.ConversationView)
        |> render("index.json", conversations: conversations)

      {:error, reason} ->
        Logger.error("Failed to list conversations for user #{user_id}: #{inspect(reason)}")

        conn
        |> put_status(500)
        |> json(%{success: false, data: nil, error: "Failed to retrieve conversations"})
    end
  end

  @doc """
  POST /api/v1/messages/conversations
  Creates or retrieves an existing conversation between two users.

  Requires participantId in body.
  """
  def create(conn, params) do
    user_id = conn.assigns.user_id
    participant_id = params["participantId"]
    participant_name = params["participantName"] || ""

    if is_nil(participant_id) || participant_id == "" do
      conn
      |> put_status(400)
      |> json(%{success: false, data: nil, error: "Missing participantId"})
    else
      case ConversationService.get_or_create_conversation(user_id, participant_id, participant_name) do
        {:ok, conversation_id} ->
          conn
          |> put_status(201)
          |> json(%{success: true, data: %{conversation_id: conversation_id}, error: nil})

        {:error, reason} ->
          Logger.error("Failed to create conversation for user #{user_id}: #{inspect(reason)}")

          conn
          |> put_status(500)
          |> json(%{success: false, data: nil, error: "Failed to create conversation"})
      end
    end
  end

  @doc """
  DELETE /api/v1/messages/conversations/:conversation_id

  Delete a chat from this user's list, the way WhatsApp and Telegram do it:
  for this user only, and only what is already there. The other side keeps
  theirs untouched, and a new message brings the chat back carrying only
  itself. The client, Sep 24: "Can we make it so you slide left to delete".
  """
  def delete(conn, %{"conversation_id" => conversation_id}) do
    user_id = conn.assigns.user_id

    case ConversationService.clear_conversation(user_id, conversation_id) do
      {:ok, cleared_at} ->
        # Its threads go with it: they hang off messages this user no longer has.
        ThreadInbox.forget_conversation(user_id, conversation_id)

        conn
        |> put_status(200)
        |> json(%{
          success: true,
          data: %{conversation_id: conversation_id, cleared_at: DateTime.to_iso8601(cleared_at)},
          error: nil
        })

      {:error, :not_found} ->
        conn
        |> put_status(404)
        |> json(%{success: false, data: nil, error: "Conversation not found"})

      {:error, reason} ->
        Logger.error("Failed to delete conversation #{conversation_id}: #{inspect(reason)}")

        conn
        |> put_status(500)
        |> json(%{success: false, data: nil, error: "Failed to delete conversation"})
    end
  end
end

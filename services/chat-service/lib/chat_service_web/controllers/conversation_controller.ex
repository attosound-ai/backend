defmodule ChatServiceWeb.ConversationController do
  use Phoenix.Controller, formats: [:json]
  require Logger

  alias ChatService.Conversations.ConversationService

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
end

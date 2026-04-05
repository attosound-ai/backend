defmodule ChatServiceWeb.ReactionController do
  use Phoenix.Controller, formats: [:json]
  require Logger

  alias ChatService.Reactions.ReactionService
  alias ChatService.Reactions.Reaction

  action_fallback ChatServiceWeb.FallbackController

  @doc """
  GET /api/v1/messages/:chat_id/:message_id/reactions
  List all reactions for a message.
  """
  def index(conn, %{"message_id" => message_id}) do
    case ReactionService.get_reactions(message_id) do
      {:ok, reactions} ->
        conn
        |> put_status(200)
        |> json(%{
          success: true,
          data: Enum.map(reactions, &Reaction.to_map/1)
        })

      {:error, _reason} ->
        conn
        |> put_status(500)
        |> json(%{success: false, data: nil, error: "Failed to get reactions"})
    end
  end

  @doc """
  POST /api/v1/messages/:chat_id/:message_id/reactions
  Add a reaction. Body: %{"emoji" => string}
  """
  def create(conn, %{"chat_id" => chat_id, "message_id" => message_id} = params) do
    user_id = conn.assigns.user_id
    emoji = params["emoji"]

    if is_nil(emoji) || emoji == "" do
      conn
      |> put_status(400)
      |> json(%{success: false, data: nil, error: "emoji is required"})
    else
      case ReactionService.add_reaction(message_id, chat_id, user_id, emoji) do
        {:ok, reaction} ->
          conn
          |> put_status(201)
          |> json(%{success: true, data: Reaction.to_map(reaction)})

        {:error, _reason} ->
          conn
          |> put_status(500)
          |> json(%{success: false, data: nil, error: "Failed to add reaction"})
      end
    end
  end

  @doc """
  DELETE /api/v1/messages/:chat_id/:message_id/reactions/:emoji
  Remove a reaction.
  """
  def delete(conn, %{"chat_id" => chat_id, "message_id" => message_id, "emoji" => emoji}) do
    user_id = conn.assigns.user_id

    case ReactionService.remove_reaction(message_id, chat_id, user_id, emoji) do
      :ok ->
        conn
        |> put_status(200)
        |> json(%{success: true, data: %{status: "removed"}})

      {:error, _reason} ->
        conn
        |> put_status(500)
        |> json(%{success: false, data: nil, error: "Failed to remove reaction"})
    end
  end
end

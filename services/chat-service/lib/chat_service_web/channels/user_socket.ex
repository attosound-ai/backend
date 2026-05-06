defmodule ChatServiceWeb.UserSocket do
  use Phoenix.Socket

  alias ChatService.Auth.JWT

  require Logger

  channel "chat:*", ChatServiceWeb.ChatChannel
  channel "user:*", ChatServiceWeb.UserChannel
  channel "post:*", ChatServiceWeb.PostChannel

  @doc """
  Authenticate the WebSocket connection by verifying the HS256 JWT
  passed as the `token` connect parameter.

  Tokens are issued by user-service and signed with the shared
  `JWT_SECRET`. See `ChatService.Auth.JWT` for the verification rules
  (algorithm pinning, expiry, issuer check, subject extraction).
  """
  @impl true
  def connect(%{"token" => token}, socket, _connect_info) do
    case JWT.verify_user_token(token) do
      {:ok, user_id} ->
        {:ok, assign(socket, :user_id, user_id)}

      {:error, reason} ->
        Logger.warning("WebSocket auth failed: #{inspect(reason)}")
        :error
    end
  end

  def connect(_params, _socket, _connect_info) do
    Logger.warning("WebSocket connection rejected: missing token")
    :error
  end

  @impl true
  def id(socket), do: "user_socket:#{socket.assigns.user_id}"
end

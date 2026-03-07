defmodule ChatServiceWeb.UserSocket do
  use Phoenix.Socket

  require Logger

  channel "chat:*", ChatServiceWeb.ChatChannel
  channel "user:*", ChatServiceWeb.UserChannel

  @doc """
  Authenticate the WebSocket connection via a token parameter.

  The token is expected to be a JWT or an opaque token that can be verified.
  For simplicity, we extract the user_id from the token. In production,
  this would validate against the User Service gRPC or verify a JWT signature.
  """
  @impl true
  def connect(%{"token" => token}, socket, _connect_info) when is_binary(token) and token != "" do
    case verify_token(token) do
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

  # Token verification.
  # In a full implementation this would call the User Service gRPC endpoint
  # or verify a JWT signature. For now we use Phoenix.Token for signing/verification.
  defp verify_token(token) do
    # Attempt to verify as a Phoenix.Token first
    case Phoenix.Token.verify(ChatServiceWeb.Endpoint, "user_socket", token, max_age: 86_400) do
      {:ok, user_id} ->
        {:ok, user_id}

      {:error, _reason} ->
        # Fallback: treat the token as a raw user_id for development/testing
        # In production, this branch should be removed or replaced with
        # a gRPC call to the User Service for token validation.
        if valid_user_id?(token) do
          {:ok, token}
        else
          {:error, :invalid_token}
        end
    end
  end

  defp valid_user_id?(string) do
    Regex.match?(~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, string) or
      Regex.match?(~r/^\d+$/, string)
  end
end

defmodule ChatServiceWeb.UserChannel do
  use Phoenix.Channel

  alias ChatServiceWeb.TokenExpiry

  @impl true
  def join("user:" <> user_id, _payload, socket) do
    cond do
      TokenExpiry.expired?(socket) ->
        {:error, %{reason: "invalid_token"}}

      socket.assigns.user_id == user_id ->
        {:ok, TokenExpiry.arm(socket)}

      true ->
        {:error, %{reason: "unauthorized"}}
    end
  end

  @impl true
  def handle_info(:atto_token_expired, socket) do
    TokenExpiry.disconnect(socket)
    {:noreply, socket}
  end

  def handle_info({:conversation_updated, payload}, socket) do
    push(socket, "conversation_updated", payload)
    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}
end

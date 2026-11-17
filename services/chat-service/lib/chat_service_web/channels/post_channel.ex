defmodule ChatServiceWeb.PostChannel do
  @moduledoc """
  Channel for real-time post interaction updates.

  Clients join `post:<postId>` to receive live interaction events
  (likes, comments, reposts, shares) broadcast by the Kafka consumer.
  This channel is read-only — it does not accept client messages.
  """
  use Phoenix.Channel

  alias ChatServiceWeb.TokenExpiry

  @impl true
  def join("post:" <> _post_id, _payload, socket) do
    if TokenExpiry.expired?(socket) do
      {:error, %{reason: "invalid_token"}}
    else
      {:ok, TokenExpiry.arm(socket)}
    end
  end

  @impl true
  def handle_info(:atto_token_expired, socket) do
    TokenExpiry.disconnect(socket)
    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  @impl true
  def handle_in(_event, _payload, socket) do
    {:noreply, socket}
  end
end

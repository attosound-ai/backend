defmodule ChatServiceWeb.PostChannel do
  @moduledoc """
  Channel for real-time post interaction updates.

  Clients join `post:<postId>` to receive live interaction events
  (likes, comments, reposts, shares) broadcast by the Kafka consumer.
  This channel is read-only — it does not accept client messages.
  """
  use Phoenix.Channel

  @impl true
  def join("post:" <> _post_id, _payload, socket) do
    {:ok, socket}
  end

  @impl true
  def handle_in(_event, _payload, socket) do
    {:noreply, socket}
  end
end

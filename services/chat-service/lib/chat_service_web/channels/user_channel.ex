defmodule ChatServiceWeb.UserChannel do
  use Phoenix.Channel

  @impl true
  def join("user:" <> user_id, _payload, socket) do
    if socket.assigns.user_id == user_id do
      {:ok, socket}
    else
      {:error, %{reason: "unauthorized"}}
    end
  end

  @impl true
  def handle_info({:conversation_updated, payload}, socket) do
    push(socket, "conversation_updated", payload)
    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}
end

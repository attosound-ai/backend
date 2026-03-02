defmodule ChatServiceWeb.ChatChannel do
  use Phoenix.Channel

  alias ChatService.Messages.MessageService
  alias ChatService.Conversations.ConversationService
  alias ChatService.Messages.Message

  require Logger

  @doc """
  Join a chat conversation channel.

  The topic format is "chat:<conversation_id>".
  Verifies that the connecting user is a participant in the conversation.
  """
  @impl true
  def join("chat:" <> conversation_id, _payload, socket) do
    user_id = socket.assigns.user_id

    case ConversationService.find_conversation(user_id, conversation_id) do
      {:ok, _conversation} ->
        socket = assign(socket, :conversation_id, conversation_id)
        send(self(), :after_join)
        {:ok, %{conversation_id: conversation_id}, socket}

      {:error, :not_found} ->
        {:error, %{reason: "not_a_participant"}}

      {:error, _reason} ->
        {:error, %{reason: "failed_to_verify_participation"}}
    end
  end

  @impl true
  def handle_info(:after_join, socket) do
    # Optionally load recent messages on join
    conversation_id = socket.assigns.conversation_id

    case MessageService.get_messages(conversation_id, limit: 25) do
      {:ok, %{messages: messages}} ->
        push(socket, "message_history", %{
          messages: Enum.map(messages, &Message.to_map/1)
        })

      {:error, _reason} ->
        Logger.warning("Failed to load message history for #{conversation_id}")
    end

    {:noreply, socket}
  end

  @doc """
  Handle incoming "new_message" events from the client.

  Payload: %{"content" => string, "content_type" => string (optional)}

  The message is saved, broadcast to all channel subscribers, and published to Kafka.
  """
  @impl true
  def handle_in("new_message", %{"content" => content} = payload, socket) do
    user_id = socket.assigns.user_id
    conversation_id = socket.assigns.conversation_id
    content_type = Map.get(payload, "content_type", "text")

    case MessageService.send_message(user_id, conversation_id, content, content_type) do
      {:ok, message} ->
        broadcast!(socket, "new_message", Message.to_map(message))
        {:reply, {:ok, Message.to_map(message)}, socket}

      {:error, reason} ->
        Logger.error("Failed to send message via channel: #{inspect(reason)}")
        {:reply, {:error, %{reason: "send_failed"}}, socket}
    end
  end

  @doc """
  Handle "typing" indicator events.

  Broadcasts typing status to all other participants in the channel.
  """
  def handle_in("typing", %{"is_typing" => is_typing}, socket) do
    user_id = socket.assigns.user_id

    broadcast_from!(socket, "typing", %{
      user_id: user_id,
      is_typing: is_typing
    })

    {:noreply, socket}
  end

  @doc """
  Handle "mark_read" events.

  Marks all messages in the conversation as read for the current user.
  """
  def handle_in("mark_read", _payload, socket) do
    user_id = socket.assigns.user_id
    conversation_id = socket.assigns.conversation_id

    case MessageService.mark_as_read(conversation_id, user_id) do
      {:ok, :marked} ->
        broadcast_from!(socket, "messages_read", %{
          user_id: user_id,
          conversation_id: conversation_id
        })

        {:reply, {:ok, %{status: "marked"}}, socket}

      {:error, reason} ->
        Logger.error("Failed to mark as read: #{inspect(reason)}")
        {:reply, {:error, %{reason: "mark_read_failed"}}, socket}
    end
  end

  def handle_in(_event, _payload, socket) do
    {:noreply, socket}
  end
end

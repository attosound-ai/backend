defmodule ChatServiceWeb.ChatChannel do
  use Phoenix.Channel

  alias ChatService.Messages.MessageService
  alias ChatService.Conversations.ConversationService
  alias ChatService.Reactions.ReactionService
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

  @impl true
  def handle_info({:new_message, message}, socket) do
    push(socket, "new_message", message)
    {:noreply, socket}
  end

  def handle_info({:reaction_added, payload}, socket) do
    push(socket, "reaction_added", payload)
    {:noreply, socket}
  end

  def handle_info({:reaction_removed, payload}, socket) do
    push(socket, "reaction_removed", payload)
    {:noreply, socket}
  end

  def handle_info({:message_edited, payload}, socket) do
    push(socket, "message_edited", payload)
    {:noreply, socket}
  end

  def handle_info({:message_deleted, payload}, socket) do
    push(socket, "message_deleted", payload)
    {:noreply, socket}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

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

    reply_opts =
      if payload["reply_to_id"] do
        [
          reply_to_id: payload["reply_to_id"],
          reply_to_content: payload["reply_to_content"] || "",
          reply_to_sender: payload["reply_to_sender"] || ""
        ]
      else
        []
      end

    with {:ok, conversation} <- ConversationService.find_conversation(user_id, conversation_id),
         opts <- [recipient_id: conversation.participant_id] ++ reply_opts,
         {:ok, message} <- MessageService.send_message(user_id, conversation_id, content, content_type, opts) do
      message_map = Message.to_map(message)
      broadcast!(socket, "new_message", message_map)

      # Notify both participants' user channels so conversation lists update in real-time
      notify_payload = %{
        conversation_id: conversation_id,
        last_message: content,
        sender_id: user_id
      }

      ChatServiceWeb.Endpoint.broadcast("user:#{user_id}", "conversation_updated", notify_payload)
      ChatServiceWeb.Endpoint.broadcast("user:#{conversation.participant_id}", "conversation_updated", notify_payload)

      # Notify recipient about new notification (for badge + list refresh)
      if user_id != conversation.participant_id do
        ChatServiceWeb.Endpoint.broadcast(
          "user:#{conversation.participant_id}",
          "new_notification",
          %{type: "message", actor_id: user_id}
        )
      end

      {:reply, {:ok, message_map}, socket}
    else
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
    conversation_id = socket.assigns.conversation_id

    Logger.info(
      "[TYPING] user=#{user_id} conv=#{conversation_id} is_typing=#{is_typing}"
    )

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

  @doc """
  Handle "add_reaction" events from the client.
  Payload: %{"message_id" => string, "emoji" => string}
  """
  def handle_in("add_reaction", %{"message_id" => message_id, "emoji" => emoji}, socket) do
    user_id = socket.assigns.user_id
    conversation_id = socket.assigns.conversation_id

    case ReactionService.add_reaction(message_id, conversation_id, user_id, emoji) do
      {:ok, _reaction} ->
        {:reply, {:ok, %{status: "added"}}, socket}

      {:error, reason} ->
        Logger.error("Failed to add reaction: #{inspect(reason)}")
        {:reply, {:error, %{reason: "add_reaction_failed"}}, socket}
    end
  end

  @doc """
  Handle "remove_reaction" events from the client.
  Payload: %{"message_id" => string, "emoji" => string}
  """
  def handle_in("remove_reaction", %{"message_id" => message_id, "emoji" => emoji}, socket) do
    user_id = socket.assigns.user_id
    conversation_id = socket.assigns.conversation_id

    case ReactionService.remove_reaction(message_id, conversation_id, user_id, emoji) do
      :ok ->
        {:reply, {:ok, %{status: "removed"}}, socket}

      {:error, reason} ->
        Logger.error("Failed to remove reaction: #{inspect(reason)}")
        {:reply, {:error, %{reason: "remove_reaction_failed"}}, socket}
    end
  end

  @doc """
  Handle "edit_message" events from the client.
  Payload: %{"message_id" => string, "content" => string}
  Only the original sender can edit.
  """
  def handle_in("edit_message", %{"message_id" => message_id, "content" => content}, socket) do
    user_id = socket.assigns.user_id
    conversation_id = socket.assigns.conversation_id

    case MessageService.edit_message(message_id, conversation_id, user_id, content) do
      {:ok, _payload} ->
        {:reply, {:ok, %{status: "edited"}}, socket}

      {:error, :forbidden} ->
        {:reply, {:error, %{reason: "not_sender"}}, socket}

      {:error, :not_found} ->
        {:reply, {:error, %{reason: "message_not_found"}}, socket}

      {:error, reason} ->
        Logger.error("Failed to edit message: #{inspect(reason)}")
        {:reply, {:error, %{reason: "edit_failed"}}, socket}
    end
  end

  @doc """
  Handle "delete_message" events from the client.
  Payload: %{"message_id" => string}
  Only the original sender can delete. Performs a soft delete.
  """
  def handle_in("delete_message", %{"message_id" => message_id}, socket) do
    user_id = socket.assigns.user_id
    conversation_id = socket.assigns.conversation_id

    case MessageService.delete_message(message_id, conversation_id, user_id) do
      {:ok, _payload} ->
        {:reply, {:ok, %{status: "deleted"}}, socket}

      {:error, :forbidden} ->
        {:reply, {:error, %{reason: "not_sender"}}, socket}

      {:error, :not_found} ->
        {:reply, {:error, %{reason: "message_not_found"}}, socket}

      {:error, reason} ->
        Logger.error("Failed to delete message: #{inspect(reason)}")
        {:reply, {:error, %{reason: "delete_failed"}}, socket}
    end
  end

  def handle_in(_event, _payload, socket) do
    {:noreply, socket}
  end
end

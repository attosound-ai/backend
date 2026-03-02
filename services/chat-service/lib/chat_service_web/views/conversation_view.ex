defmodule ChatServiceWeb.ConversationView do
  use Phoenix.Component

  alias ChatService.Conversations.Conversation

  @doc """
  Render a list of conversations.
  """
  def render("index.json", %{conversations: conversations}) do
    %{
      success: true,
      data: Enum.map(conversations, &render_conversation/1),
      error: nil
    }
  end

  @doc """
  Render a single conversation.
  """
  def render("show.json", %{conversation: conversation}) do
    %{
      success: true,
      data: render_conversation(conversation),
      error: nil
    }
  end

  defp render_conversation(%Conversation{} = conv) do
    Conversation.to_map(conv)
  end
end

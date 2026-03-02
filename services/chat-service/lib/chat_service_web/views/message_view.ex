defmodule ChatServiceWeb.MessageView do
  use Phoenix.Component

  alias ChatService.Messages.Message

  @doc """
  Render a list of messages with pagination metadata.
  """
  def render("index.json", %{messages: messages, next_cursor: next_cursor, has_more: has_more}) do
    %{
      success: true,
      data: %{
        messages: Enum.map(messages, &render_message/1),
        pagination: %{
          next_cursor: next_cursor,
          has_more: has_more
        }
      },
      error: nil
    }
  end

  @doc """
  Render a single message.
  """
  def render("show.json", %{message: message}) do
    %{
      success: true,
      data: render_message(message),
      error: nil
    }
  end

  defp render_message(%Message{} = message) do
    Message.to_map(message)
  end
end

defmodule ChatService.Messages.ConversationUpdatedPayloadTest do
  @moduledoc """
  The `conversation_updated` socket event. The app writes the banner of a new
  message from `last_message`, so a media message must never travel there as
  the hosted address of its file.
  """

  use ExUnit.Case, async: true

  alias ChatService.Messages.MessageService

  @conversation_id "22222222-2222-2222-2222-222222222222"
  @video_url "https://res.cloudinary.com/dxzcutnlp/video/upload/v1/atto/chat/abc.mp4"

  defp payload(content, type),
    do: MessageService.conversation_updated_payload(@conversation_id, "277", content, type)

  test "a text message goes out as written, with its type" do
    assert payload("see you at 8", "text") == %{
             conversation_id: @conversation_id,
             last_message: "see you at 8",
             content_type: "text",
             sender_id: "277"
           }
  end

  test "a video never carries the address of the file" do
    result = payload(@video_url, "video")
    assert result.last_message == "[video]"
    assert result.content_type == "video"
    refute String.contains?(result.last_message, "http")
  end

  test "every media type becomes its marker" do
    for type <- ~w(image video video_note audio file contact post location) do
      result = payload(@video_url, type)
      assert result.last_message == "[" <> type <> "]"
      assert result.content_type == type
    end
  end

  test "a pasted link in a text message is still the link" do
    assert payload(@video_url, "text").last_message == @video_url
  end

  test "a missing type reads as text, as the rest of the service does" do
    assert payload("hello", nil).content_type == "text"
    assert payload("hello", "").content_type == "text"
    assert payload("hello", nil).last_message == "hello"
  end
end

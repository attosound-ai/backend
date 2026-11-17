defmodule ChatService.Messages.MessageSentDataTest do
  @moduledoc """
  The `data` of the `message.sent` Kafka event. social-service writes the push
  of a chat message from it, so it must carry the type and the metadata of a
  media message, whose `content` is only a hosted URL.
  """

  use ExUnit.Case, async: true

  alias ChatService.Messages.Message
  alias ChatService.Messages.MessageService

  @conversation_id "22222222-2222-2222-2222-222222222222"
  @message_id "11111111-1111-1111-1111-111111111111"
  @created_at ~U[2026-10-06 12:00:00.000000Z]

  defp message(attrs) do
    struct!(
      %Message{
        conversation_id: @conversation_id,
        message_id: @message_id,
        sender_id: "277",
        content: "hello",
        content_type: "text",
        created_at: @created_at
      },
      attrs
    )
  end

  test "a text message keeps the fields it always had" do
    assert MessageService.message_sent_data(message([]), "266") == %{
             conversation_id: @conversation_id,
             message_id: @message_id,
             sender_id: "277",
             recipient_id: "266",
             content: "hello",
             content_type: "text",
             created_at: "2026-10-06T12:00:00.000000Z"
           }
  end

  test "a media message carries its type and its metadata" do
    data =
      MessageService.message_sent_data(
        message(
          content: "https://res.cloudinary.com/atto/video/upload/v1/chat/voice.m4a",
          content_type: "audio",
          metadata: %{"durationMs" => 12_000, "waveform" => [0.1, 0.9]}
        ),
        "266"
      )

    assert data.content_type == "audio"
    assert data.metadata == %{"durationMs" => 12_000, "waveform" => [0.1, 0.9]}
  end

  test "the metadata survives the JSON encoding the producer applies" do
    data =
      MessageService.message_sent_data(
        message(
          content: "https://res.cloudinary.com/atto/raw/upload/v1/chat/report.pdf",
          content_type: "file",
          metadata: %{"fileName" => "report.pdf", "bytes" => 2048}
        ),
        "266"
      )

    decoded = data |> Jason.encode!() |> Jason.decode!()

    assert decoded["content_type"] == "file"
    assert decoded["metadata"] == %{"fileName" => "report.pdf", "bytes" => 2048}
  end

  test "no metadata key when the message has none" do
    refute Map.has_key?(
             MessageService.message_sent_data(message(metadata: nil), "266"),
             :metadata
           )

    refute Map.has_key?(
             MessageService.message_sent_data(message(metadata: %{}), "266"),
             :metadata
           )
  end

  test "no recipient_id key when the recipient is unknown" do
    refute Map.has_key?(MessageService.message_sent_data(message([])), :recipient_id)
    refute Map.has_key?(MessageService.message_sent_data(message([]), nil), :recipient_id)
  end
end

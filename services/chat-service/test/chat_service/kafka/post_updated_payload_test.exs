defmodule ChatService.KafkaConsumer.PostUpdatedPayloadTest do
  @moduledoc """
  What every phone showing a post receives when its author edits it (the
  cover of an audio post, Nov 2026), without Kafka or Phoenix.
  """
  use ExUnit.Case, async: true

  alias ChatService.KafkaConsumer.MessageHandler

  test "a cover edit carries the post's public fields" do
    event = %{
      "content_id" => "6730abc",
      "author_id" => "153",
      "updated_at" => "2026-11-12T15:00:00Z",
      "tagged_user_ids" => ["167"],
      "content_type" => "audio",
      "text_content" => "Welcome home",
      "metadata" => %{"duration" => "32", "coverPublicId" => "atto/content/square_1"}
    }

    assert {:ok, "6730abc", out} = MessageHandler.post_updated_payload(event)

    assert out == %{
             "content_id" => "6730abc",
             "content_type" => "audio",
             "text_content" => "Welcome home",
             "metadata" => %{"duration" => "32", "coverPublicId" => "atto/content/square_1"},
             "updated_at" => "2026-11-12T15:00:00Z"
           }
  end

  test "the tagged ids and the author stay out, and missing fields are not sent as null" do
    {:ok, _, out} =
      MessageHandler.post_updated_payload(%{
        "content_id" => "p1",
        "author_id" => "153",
        "tagged_user_ids" => ["167"],
        "text_content" => nil
      })

    assert out == %{"content_id" => "p1"}
  end

  test "a wrapped event is read from data" do
    assert {:ok, "p2", %{"content_id" => "p2"}} =
             MessageHandler.post_updated_payload(%{"data" => %{"content_id" => "p2"}})
  end

  test "an event without a post id is skipped" do
    assert :skip == MessageHandler.post_updated_payload(%{"author_id" => "153"})
    assert :skip == MessageHandler.post_updated_payload(%{"content_id" => ""})
    assert :skip == MessageHandler.post_updated_payload("nope")
  end
end

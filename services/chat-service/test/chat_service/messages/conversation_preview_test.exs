defmodule ChatService.Messages.ConversationPreviewTest do
  @moduledoc """
  The rules of what the conversation list says after a delete, without
  Cassandra: which sentence goes in whose row, and when the list changes at all.
  """
  use ExUnit.Case, async: true

  alias ChatService.Messages.ConversationPreview

  describe "preview_for/2" do
    test "whoever deleted the message gets their own wording" do
      assert ConversationPreview.preview_for("152", "152") == "🚫 You deleted this message"
    end

    test "the other person gets the neutral one" do
      assert ConversationPreview.preview_for("281", "152") == "🚫 This message was deleted"
    end

    test "ids compare as text, whatever type they arrive in" do
      assert ConversationPreview.preview_for(152, "152") == "🚫 You deleted this message"
      assert ConversationPreview.preview_for("152", 152) == "🚫 You deleted this message"
      assert ConversationPreview.preview_for(153, 152) == "🚫 This message was deleted"
    end
  end

  describe "last_message?/2" do
    @newest "6045f684-c206-11f1-87d1-a2aaf4379a06"
    @older "13df9f70-c206-11f1-985b-a2aaf4379a06"

    test "true only for the newest message of the conversation" do
      assert ConversationPreview.last_message?(@newest, @newest)
      refute ConversationPreview.last_message?(@newest, @older)
    end

    test "letter case of the id does not matter" do
      assert ConversationPreview.last_message?(String.upcase(@newest), @newest)
      assert ConversationPreview.last_message?(@newest, String.upcase(@newest))
    end

    test "an empty conversation, or a missing id, changes nothing" do
      refute ConversationPreview.last_message?(nil, @newest)
      refute ConversationPreview.last_message?(@newest, nil)
    end
  end

  test "the two sentences are the ones the apps translate" do
    # The apps match these strings exactly (front: messagePreview.ts) and show
    # them in the person's language; older builds show them as stored.
    assert ConversationPreview.preview_for("a", "b") == "🚫 This message was deleted"
    assert ConversationPreview.preview_for("a", "a") == "🚫 You deleted this message"
  end
end

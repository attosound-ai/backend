defmodule ChatService.Messages.EditPolicyTest do
  use ExUnit.Case, async: true
  alias ChatService.Messages.EditPolicy

  @sent ~U[2026-10-04 12:00:00Z]
  defp row(extra \\ %{}),
    do: Map.merge(%{"sender_id" => "282", "created_at" => @sent, "content_type" => "text"}, extra)

  test "the sender can edit a fresh text message" do
    assert :ok == EditPolicy.check(row(), "282", [], DateTime.add(@sent, 60))
  end

  test "only the sender" do
    assert {:error, :forbidden} == EditPolicy.check(row(), "152", [], @sent)
  end

  test "15 minutes, like iMessage" do
    assert :ok == EditPolicy.check(row(), "282", [], DateTime.add(@sent, 15 * 60))
    assert {:error, :edit_window_closed} ==
             EditPolicy.check(row(), "282", [], DateTime.add(@sent, 15 * 60 + 1))
  end

  test "at most 5 edits" do
    four = List.duplicate(%{"content" => "x"}, 4)
    five = List.duplicate(%{"content" => "x"}, 5)
    assert :ok == EditPolicy.check(row(), "282", four, @sent)
    assert {:error, :edit_limit_reached} == EditPolicy.check(row(), "282", five, @sent)
  end

  test "deleted, media and missing messages cannot be edited" do
    assert {:error, :not_found} == EditPolicy.check(row(%{"is_deleted" => true}), "282", [], @sent)
    assert {:error, :not_editable} == EditPolicy.check(row(%{"content_type" => "image"}), "282", [], @sent)
    assert {:error, :not_found} == EditPolicy.check(nil, "282", [], @sent)
  end

  test "history keeps every replaced version in order" do
    h = EditPolicy.append([], "first", @sent)
    h = EditPolicy.append(h, "second", DateTime.add(@sent, 30))
    assert [%{"content" => "first", "since" => "2026-10-04T12:00:00Z"},
            %{"content" => "second", "since" => "2026-10-04T12:00:30Z"}] == h
  end

  test "decode tolerates empty and broken values" do
    assert [] == EditPolicy.decode(nil)
    assert [] == EditPolicy.decode("")
    assert [] == EditPolicy.decode("{bad")
    assert [%{"content" => "a"}] == EditPolicy.decode(~s([{"content":"a"}]))
  end
end

defmodule ChatService.Accounts.DeactivatedTest do
  # The ETS table is global to the node: not async.
  use ExUnit.Case, async: false

  alias ChatService.Accounts.Deactivated

  setup do
    on_exit(fn -> Deactivated.remove(["281", "282"]) end)
    :ok
  end

  test "an account in deletion grace leaves every conversation list and comes back on recovery" do
    convs = [
      %{participant_id: "280", conversation_id: "a"},
      %{participant_id: "281", conversation_id: "b"},
      %{"participant_id" => "281", "conversation_id" => "c"}
    ]

    refute Deactivated.deactivated?("281")
    assert length(Deactivated.reject_hidden_participants(convs)) == 3

    Deactivated.add(["281", 282])
    assert Deactivated.deactivated?("281")
    assert Deactivated.deactivated?(282)
    assert Deactivated.any?()
    assert [%{conversation_id: "a"}] = Deactivated.reject_hidden_participants(convs)

    Deactivated.remove(["281"])
    refute Deactivated.deactivated?("281")
    assert length(Deactivated.reject_hidden_participants(convs)) == 3
  end

  test "nil and blank ids are never hidden" do
    Deactivated.add([nil, ""])
    refute Deactivated.deactivated?(nil)
    refute Deactivated.deactivated?("")
  end

  test "the rule takes any predicate" do
    convs = [%{participant_id: "1"}, %{participant_id: "2"}]
    assert [%{participant_id: "2"}] = Deactivated.reject_hidden_participants(convs, &(&1 == "1"))
  end
end

defmodule ChatService.Messages.MessageServiceDeleteTest do
  @moduledoc """
  Unit tests for the `MessageService.delete_message/3` pipeline.

  The pipeline is exercised with swappable stubs for every collaborator
  (Authorizer, Persistence, ReactionCleaner, EventPublisher). No Cassandra,
  Kafka, or Phoenix.PubSub is touched, so these tests are fast and fully
  deterministic — proof that the SOLID refactor made the orchestrator
  testable without infrastructure.
  """

  # async: false because the stubs are configured via Application env,
  # which is process-global. Running concurrently would cause cross-talk.
  use ExUnit.Case, async: false

  alias ChatService.Messages.MessageService
  alias ChatService.Test.Doubles

  @message_id "11111111-1111-1111-1111-111111111111"
  @conversation_id "22222222-2222-2222-2222-222222222222"
  @user_id "user-42"

  setup do
    original = %{
      authorizer: Application.get_env(:chat_service, :message_authorizer),
      persistence: Application.get_env(:chat_service, :message_persistence),
      cleaner: Application.get_env(:chat_service, :message_reaction_cleaner),
      publisher: Application.get_env(:chat_service, :message_event_publisher)
    }

    on_exit(fn ->
      restore(:message_authorizer, original.authorizer)
      restore(:message_persistence, original.persistence)
      restore(:message_reaction_cleaner, original.cleaner)
      restore(:message_event_publisher, original.publisher)
    end)

    :ok
  end

  defp restore(key, nil), do: Application.delete_env(:chat_service, key)
  defp restore(key, value), do: Application.put_env(:chat_service, key, value)

  defp swap(stubs) when is_list(stubs) do
    Enum.each(stubs, fn {key, module} ->
      Application.put_env(:chat_service, key, module)
    end)
  end

  describe "delete_message/3 — happy path" do
    test "runs the full pipeline and returns the payload with audit fields" do
      swap(
        message_authorizer: Doubles.Authorizer.Ok,
        message_persistence: Doubles.Persistence.Ok,
        message_reaction_cleaner: Doubles.ReactionCleaner.Recording,
        message_event_publisher: Doubles.EventPublisher.Recording
      )

      assert {:ok, payload} =
               MessageService.delete_message(@message_id, @conversation_id, @user_id)

      assert payload.message_id == @message_id
      assert payload.conversation_id == @conversation_id
      assert payload.sender_id == @user_id
      assert payload.deleted_by == @user_id
      assert payload.is_deleted == true
      assert payload.deleted_at == Doubles.Persistence.Ok.fixed_timestamp()
    end

    test "invokes collaborators in the right order: persist → cascade → publish" do
      swap(
        message_authorizer: Doubles.Authorizer.Ok,
        message_persistence: Doubles.Persistence.Ok,
        message_reaction_cleaner: Doubles.ReactionCleaner.Recording,
        message_event_publisher: Doubles.EventPublisher.Recording
      )

      {:ok, _} = MessageService.delete_message(@message_id, @conversation_id, @user_id)

      # Persistence runs first
      assert_received {:persistence_soft_delete, @message_id, @conversation_id, @user_id}
      # Cascade runs next, before publish
      assert_received {:reaction_cleaner_cleanup, @message_id, @conversation_id}
      # Publish runs last, with payload containing the persistence-stamped timestamp
      assert_received {:event_publisher_deleted, publish_payload}
      assert publish_payload.deleted_at == Doubles.Persistence.Ok.fixed_timestamp()
    end
  end

  describe "delete_message/3 — authorization failures" do
    test "propagates :forbidden and skips persistence, cascade, publish" do
      swap(
        message_authorizer: Doubles.Authorizer.Forbidden,
        message_persistence: Doubles.Persistence.Ok,
        message_reaction_cleaner: Doubles.ReactionCleaner.Recording,
        message_event_publisher: Doubles.EventPublisher.Recording
      )

      assert {:error, :forbidden} =
               MessageService.delete_message(@message_id, @conversation_id, @user_id)

      refute_received {:persistence_soft_delete, _, _, _}
      refute_received {:reaction_cleaner_cleanup, _, _}
      refute_received {:event_publisher_deleted, _}
    end

    test "propagates :not_found without touching downstream stages" do
      swap(
        message_authorizer: Doubles.Authorizer.NotFound,
        message_persistence: Doubles.Persistence.Ok,
        message_reaction_cleaner: Doubles.ReactionCleaner.Recording,
        message_event_publisher: Doubles.EventPublisher.Recording
      )

      assert {:error, :not_found} =
               MessageService.delete_message(@message_id, @conversation_id, @user_id)

      refute_received {:persistence_soft_delete, _, _, _}
      refute_received {:event_publisher_deleted, _}
    end

    test "propagates :query_failed when the authorizer's DB lookup blows up" do
      swap(
        message_authorizer: Doubles.Authorizer.QueryFailed,
        message_persistence: Doubles.Persistence.Ok,
        message_reaction_cleaner: Doubles.ReactionCleaner.Recording,
        message_event_publisher: Doubles.EventPublisher.Recording
      )

      assert {:error, :query_failed} =
               MessageService.delete_message(@message_id, @conversation_id, @user_id)

      refute_received {:persistence_soft_delete, _, _, _}
      refute_received {:event_publisher_deleted, _}
    end
  end

  describe "delete_message/3 — persistence failures" do
    test "propagates :update_failed and does not cascade or publish" do
      swap(
        message_authorizer: Doubles.Authorizer.Ok,
        message_persistence: Doubles.Persistence.Fails,
        message_reaction_cleaner: Doubles.ReactionCleaner.Recording,
        message_event_publisher: Doubles.EventPublisher.Recording
      )

      assert {:error, :update_failed} =
               MessageService.delete_message(@message_id, @conversation_id, @user_id)

      refute_received {:reaction_cleaner_cleanup, _, _}
      refute_received {:event_publisher_deleted, _}
    end
  end
end

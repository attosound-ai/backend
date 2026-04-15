defmodule ChatService.Test.Doubles do
  @moduledoc """
  Test doubles for the message delete pipeline.

  Each collaborator has a set of stub implementations covering the outcomes
  `MessageService.delete_message/3` must handle. Recording doubles forward
  every call to the test process via `send(self(), {:called, ...})`, which
  lets tests assert both *that* a collaborator was invoked and *in which order*
  (via `assert_receive`).
  """

  # ── Authorizer doubles ────────────────────────────────────────────────

  defmodule Authorizer.Ok do
    @behaviour ChatService.Messages.Authorizer
    @impl true
    def can_delete?(_message_id, _conversation_id, _user_id), do: :ok
  end

  defmodule Authorizer.Forbidden do
    @behaviour ChatService.Messages.Authorizer
    @impl true
    def can_delete?(_message_id, _conversation_id, _user_id), do: {:error, :forbidden}
  end

  defmodule Authorizer.NotFound do
    @behaviour ChatService.Messages.Authorizer
    @impl true
    def can_delete?(_message_id, _conversation_id, _user_id), do: {:error, :not_found}
  end

  defmodule Authorizer.QueryFailed do
    @behaviour ChatService.Messages.Authorizer
    @impl true
    def can_delete?(_message_id, _conversation_id, _user_id), do: {:error, :query_failed}
  end

  # ── Persistence doubles ───────────────────────────────────────────────

  defmodule Persistence.Ok do
    @behaviour ChatService.Messages.Persistence
    @fixed_timestamp ~U[2026-04-14 12:00:00.000000Z]
    def fixed_timestamp, do: @fixed_timestamp

    @impl true
    def soft_delete(message_id, conversation_id, user_id) do
      send(self(), {:persistence_soft_delete, message_id, conversation_id, user_id})
      {:ok, @fixed_timestamp}
    end
  end

  defmodule Persistence.Fails do
    @behaviour ChatService.Messages.Persistence
    @impl true
    def soft_delete(_message_id, _conversation_id, _user_id), do: {:error, :update_failed}
  end

  # ── ReactionCleaner doubles ───────────────────────────────────────────

  defmodule ReactionCleaner.Recording do
    @behaviour ChatService.Messages.ReactionCleaner
    @impl true
    def cleanup(message_id, conversation_id) do
      send(self(), {:reaction_cleaner_cleanup, message_id, conversation_id})
      :ok
    end
  end

  # ── EventPublisher doubles ────────────────────────────────────────────

  defmodule EventPublisher.Recording do
    @behaviour ChatService.Messages.EventPublisher
    @impl true
    def publish_deleted(payload) do
      send(self(), {:event_publisher_deleted, payload})
      :ok
    end
  end
end

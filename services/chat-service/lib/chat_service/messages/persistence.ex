defmodule ChatService.Messages.Persistence do
  @moduledoc """
  Persistence contract for message mutations.

  Separating persistence from orchestration lets `MessageService` stay thin
  and lets tests exercise the delete pipeline without touching Cassandra
  (SOLID: Dependency Inversion). Only the mutations used by the current
  feature live here; send/edit continue using their inline queries until a
  future refactor widens the scope.

  The concrete implementation is resolved at runtime via `Application.get_env/3`.
  """

  @typedoc "Successful soft-delete returns the timestamp stamped in Cassandra."
  @type soft_delete_result :: {:ok, DateTime.t()} | {:error, :update_failed}

  @callback soft_delete(
              message_id :: String.t(),
              conversation_id :: String.t(),
              deleted_by :: String.t()
            ) :: soft_delete_result()

  @spec soft_delete(String.t(), String.t(), String.t()) :: soft_delete_result()
  def soft_delete(message_id, conversation_id, deleted_by) do
    impl().soft_delete(message_id, conversation_id, deleted_by)
  end

  defp impl do
    Application.get_env(
      :chat_service,
      :message_persistence,
      ChatService.Messages.Persistence.Cassandra
    )
  end
end

defmodule ChatService.Messages.Persistence.Cassandra do
  @moduledoc """
  Cassandra-backed implementation of `ChatService.Messages.Persistence`.

  The soft delete is a tombstone write that preserves the row (so pagination
  cursors, reply references, and reaction threads don't break) while
  clearing `content` and stamping audit fields. `deleted_at` and `deleted_by`
  are intentionally added alongside `is_deleted` instead of replacing it, so
  existing readers (channel push, REST controllers) keep working unchanged.
  """

  @behaviour ChatService.Messages.Persistence

  alias ChatService.Repo
  require Logger

  @impl true
  def soft_delete(message_id, conversation_id, deleted_by) do
    now = DateTime.utc_now()

    query = """
    UPDATE messages
    SET is_deleted = true,
        content = '',
        deleted_at = ?,
        deleted_by = ?
    WHERE conversation_id = ? AND message_id = ?
    """

    params = %{
      "deleted_at" => {"timestamp", now},
      "deleted_by" => {"text", deleted_by},
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, _} ->
        {:ok, now}

      {:error, reason} ->
        Logger.error("Persistence.soft_delete failed: #{inspect(reason)}")
        {:error, :update_failed}
    end
  end
end

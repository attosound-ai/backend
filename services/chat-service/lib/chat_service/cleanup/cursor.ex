defmodule ChatService.Cleanup.Cursor do
  @moduledoc """
  Persists the Cassandra `paging_state` of `mix chat.cleanup_orphans` in the
  `cleanup_checkpoints` table so a long scan can resume after a crash/timeout
  (`--resume`). The paging_state is an opaque binary blob.
  """

  alias ChatService.Repo

  @job "cleanup_orphans"

  @spec read() :: binary() | nil
  def read do
    case Repo.execute_prepared(
           "SELECT paging_state FROM cleanup_checkpoints WHERE job = ?",
           %{"job" => {"text", @job}}
         ) do
      {:ok, result} ->
        case Enum.to_list(result) do
          [%{"paging_state" => ps} | _] when is_binary(ps) -> ps
          _ -> nil
        end

      _ ->
        nil
    end
  end

  @spec write(binary() | nil) :: :ok
  def write(nil), do: clear()

  def write(paging_state) when is_binary(paging_state) do
    Repo.execute_prepared(
      "INSERT INTO cleanup_checkpoints (job, paging_state, updated_at) VALUES (?, ?, ?)",
      %{
        "job" => {"text", @job},
        "paging_state" => {"blob", paging_state},
        "updated_at" => {"timestamp", DateTime.utc_now()}
      }
    )

    :ok
  end

  @spec clear() :: :ok
  def clear do
    Repo.execute_prepared("DELETE FROM cleanup_checkpoints WHERE job = ?", %{
      "job" => {"text", @job}
    })

    :ok
  end
end

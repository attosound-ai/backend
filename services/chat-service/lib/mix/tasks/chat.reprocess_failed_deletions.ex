defmodule Mix.Tasks.Chat.ReprocessFailedDeletions do
  @shortdoc "Retry account-deletion cascades that were dead-lettered to failed_deletions"
  @moduledoc """
  Reprocesses the chat-cascade dead-letter table `failed_deletions` (written by
  `ChatService.KafkaConsumer` when a `user.deleted` cascade keeps failing).

  For each entry it re-runs the robust deletion primitive. On success the row is
  removed; on failure the row is updated with the latest reason and a Sentry
  event is emitted. Safe to run repeatedly (idempotent) — e.g. from cron.

  Usage:
      mix chat.reprocess_failed_deletions
  """
  use Mix.Task

  alias ChatService.Repo
  alias ChatService.Conversations.AccountDeletion
  alias ChatService.Telemetry.Audit

  require Logger

  @impl Mix.Task
  def run(_args) do
    {:ok, _} = Application.ensure_all_started(:chat_service)

    case Repo.execute_prepared("SELECT user_id FROM failed_deletions", %{}) do
      {:ok, result} ->
        rows = Enum.to_list(result)
        Logger.info("reprocess_failed_deletions: #{length(rows)} pending")
        acc = Enum.reduce(rows, %{ok: 0, failed: 0}, &reprocess(&1, &2))
        Logger.info("reprocess_failed_deletions done: #{inspect(acc)}")
        Audit.log(:reprocess_failed_deletions_summary, acc)

      {:error, reason} ->
        Logger.error("reprocess_failed_deletions: cannot read failed_deletions: #{inspect(reason)}")
        Sentry.capture_message("reprocess_failed_deletions read failed",
          level: :error,
          extra: %{reason: inspect(reason)}
        )
    end
  end

  defp reprocess(row, acc) do
    user_id = to_string(row["user_id"])

    case AccountDeletion.delete_all_for_user(user_id) do
      {:ok, _summary} ->
        Repo.execute_prepared("DELETE FROM failed_deletions WHERE user_id = ?", %{
          "user_id" => {"text", user_id}
        })

        Audit.log(:dlq_reprocessed_ok, %{user_id: user_id})
        Map.update!(acc, :ok, &(&1 + 1))

      {:error, reason, _partial} ->
        Repo.execute_prepared(
          "UPDATE failed_deletions SET reason = ?, failed_at = ? WHERE user_id = ?",
          %{
            "reason" => {"text", inspect(reason)},
            "failed_at" => {"timestamp", DateTime.utc_now()},
            "user_id" => {"text", user_id}
          }
        )

        Sentry.capture_message("dlq reprocess still failing",
          level: :error,
          extra: %{user_id: user_id, reason: inspect(reason)}
        )

        Map.update!(acc, :failed, &(&1 + 1))
    end
  end
end

defmodule Mix.Tasks.Chat.CleanupOrphans do
  @shortdoc "Delete orphaned conversations (+messages/reactions) left by deleted accounts"
  @moduledoc """
  One-shot maintenance task that removes chat rows belonging to hard-deleted
  accounts.

  It loads the set of live user ids from the user-service Postgres
  (`USER_SERVICE_DB_URL`), full-scans the `conversations` table in bounded pages,
  and deletes any row whose owner or participant no longer exists. Messages and
  reactions of a conversation are removed once it has no live participant left
  (for a 1:1 conversation an orphan row already implies that).

  Every deleted row is written to the structured audit log + a Sentry breadcrumb
  BEFORE the delete (there is no dry-run; this is the forensic trail).

  Flags:
    * `--resume`  continue from the last persisted page (after a crash/timeout)
    * `--max N`   stop after N orphan rows (saves the cursor; use --resume to go on)

  Usage:
      USER_SERVICE_DB_URL=postgresql://atto:atto_dev@localhost:5440/atto_users \\
        mix chat.cleanup_orphans
  """
  use Mix.Task

  alias ChatService.Repo
  alias ChatService.Conversations.AccountDeletion
  alias ChatService.Cleanup.{LiveUserSet, Cursor}
  alias ChatService.Telemetry.Audit

  require Logger

  @page_size 500
  @scan_timeout 30_000

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, switches: [resume: :boolean, max: :integer])
    {:ok, _} = Application.ensure_all_started(:chat_service)

    live = LiveUserSet.load!()
    Logger.info("cleanup_orphans: loaded #{MapSet.size(live)} live users")

    cursor = if opts[:resume], do: Cursor.read(), else: nil

    acc = %{
      scanned: 0,
      orphan_rows: 0,
      content_deleted: 0,
      errors: 0,
      max: opts[:max],
      content_done: MapSet.new()
    }

    final = scan(live, cursor, acc)

    summary = final |> Map.drop([:max, :content_done])
    Logger.info("cleanup_orphans done: #{inspect(summary)}")
    Audit.log(:cleanup_orphans_summary, summary)
  end

  defp scan(live, cursor, acc) do
    query = "SELECT user_id, conversation_id, participant_id, updated_at FROM conversations"
    base_opts = [page_size: @page_size, timeout: @scan_timeout]
    opts = if cursor, do: Keyword.put(base_opts, :paging_state, cursor), else: base_opts

    case Repo.execute_page(query, %{}, opts) do
      {:ok, page} ->
        acc = Enum.reduce(page, acc, fn row, a -> process_row(row, live, a) end)
        next = page.paging_state
        # Checkpoint AFTER processing the page so --resume restarts at the next page.
        Cursor.write(next)

        cond do
          reached_max?(acc) ->
            Logger.warning("cleanup_orphans: hit --max=#{acc.max}; cursor saved, rerun with --resume")
            acc

          next != nil ->
            scan(live, next, acc)

          true ->
            Cursor.clear()
            acc
        end

      {:error, reason} ->
        Sentry.capture_message("cleanup_orphans scan page failed",
          level: :error,
          extra: %{reason: inspect(reason)}
        )

        Logger.error("cleanup_orphans: scan page failed: #{inspect(reason)} — cursor preserved, rerun with --resume")
        Map.update!(acc, :errors, &(&1 + 1))
    end
  end

  defp process_row(row, live, acc) do
    owner = to_string(row["user_id"])
    other = case row["participant_id"] do
      nil -> nil
      p -> to_string(p)
    end

    acc = Map.update!(acc, :scanned, &(&1 + 1))

    owner_dead = not MapSet.member?(live, owner)
    other_dead = other != nil and not MapSet.member?(live, other)

    if owner_dead or other_dead do
      delete_orphan(row, owner, other, owner_dead, other_dead, acc)
    else
      acc
    end
  end

  defp delete_orphan(row, owner, other, owner_dead, other_dead, acc) do
    conv_id = to_string(row["conversation_id"])

    reason =
      cond do
        owner_dead and other_dead -> :both_dead
        owner_dead -> :owner_dead
        true -> :participant_dead
      end

    # Forensic record BEFORE the destructive op (RF=1, no safety net).
    Audit.log(:orphan_conversation_row, %{
      user_id: owner,
      participant_id: other,
      conversation_id: conv_id,
      reason: reason
    })

    AccountDeletion.delete_conversation_row(owner, row["updated_at"], conv_id)
    acc = Map.update!(acc, :orphan_rows, &(&1 + 1))

    # For a 1:1 conversation, an orphan row means no fully-live row can exist for
    # this conversation, so its content is safe to delete. Dedupe per conversation
    # to avoid redundant deletes/tombstones when both sides are scanned.
    if MapSet.member?(acc.content_done, conv_id) do
      acc
    else
      case AccountDeletion.delete_conversation_content(conv_id) do
        {:ok, n} ->
          Audit.log(:orphan_conversation_content, %{conversation_id: conv_id, reactions_deleted: n})

          acc
          |> Map.update!(:content_deleted, &(&1 + 1))
          |> Map.update!(:content_done, &MapSet.put(&1, conv_id))

        {:error, r} ->
          Sentry.capture_message("orphan content delete failed",
            level: :error,
            extra: %{conversation_id: conv_id, reason: inspect(r)}
          )

          Map.update!(acc, :errors, &(&1 + 1))
      end
    end
  end

  defp reached_max?(%{max: nil}), do: false
  defp reached_max?(%{max: max, orphan_rows: n}), do: n >= max
end

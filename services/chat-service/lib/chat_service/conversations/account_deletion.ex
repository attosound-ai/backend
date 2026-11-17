defmodule ChatService.Conversations.AccountDeletion do
  @moduledoc """
  Robust, idempotent cascade deletion of all chat data for a user.

  Replaces the previous best-effort `delete_all_for_user/1`: every Cassandra step
  is wrapped so one failure neither crashes the caller nor silently swallows the
  error. Returns a structured summary so the Kafka consumer can decide whether to
  retry / dead-letter, and emits telemetry (Sentry + PostHog + audit log).

  Reused by:
    * `ChatService.KafkaConsumer` — full cascade when an account is deleted.
    * `Mix.Tasks.Chat.CleanupOrphans` — via the public row/content helpers.

  Also fixes a latent bug in the old code: `reactions` (keyed by `message_id`)
  were never deleted, leaving orphaned reactions behind.
  """

  alias ChatService.Repo
  alias ChatService.Telemetry.{Audit, Posthog}
  require Logger

  @type summary :: %{
          user_id: String.t(),
          conversations: non_neg_integer(),
          reactions: non_neg_integer(),
          failures: [tuple()]
        }

  @doc """
  Delete every conversation, message and reaction belonging to `user_id`
  (both denormalized sides). Idempotent: re-running on already-clean data is a
  no-op.

  Returns `{:ok, summary}` when everything succeeded, or
  `{:error, reason, partial_summary}` when any step failed (progress is kept).
  """
  @spec delete_all_for_user(term()) :: {:ok, summary} | {:error, term(), summary}
  def delete_all_for_user(user_id) do
    user_id = to_string(user_id)
    Audit.breadcrumb("account_deletion_start", %{user_id: user_id})
    summary = %{user_id: user_id, conversations: 0, reactions: 0, failures: []}

    case list_user_conversations(user_id) do
      {:ok, rows} ->
        summary =
          Enum.reduce(rows, summary, fn row, acc ->
            conv_id = to_string(row["conversation_id"])
            participant = row["participant_id"] && to_string(row["participant_id"])

            Audit.log(:deleting_conversation, %{
              user_id: user_id,
              conversation_id: conv_id,
              participant_id: participant
            })

            cascade_one(acc, conv_id, participant, user_id)
          end)

        # Finally remove the deleted user's own partition.
        summary =
          case delete_owner_partition(user_id) do
            :ok -> summary
            {:error, reason} -> add_failure(summary, {:delete_owner_rows, reason})
          end

        finalize(user_id, summary)

      {:error, reason} ->
        finalize(user_id, add_failure(summary, {:list_conversations, reason}))
    end
  end

  # ---- Public helpers reused by the cleanup task ----

  @doc "Delete a single `conversations` row by its full primary key. Idempotent."
  @spec delete_conversation_row(term(), term(), term()) :: :ok | {:error, term()}
  def delete_conversation_row(user_id, updated_at, conversation_id) do
    safe_exec(
      "DELETE FROM conversations WHERE user_id = ? AND updated_at = ? AND conversation_id = ?",
      %{
        "user_id" => {"text", to_string(user_id)},
        "updated_at" => {"timestamp", updated_at},
        "conversation_id" => {"uuid", to_string(conversation_id)}
      }
    )
  end

  @doc """
  Delete all content (reactions + messages) of a conversation. Only call this
  when no live participant remains. Returns `{:ok, reactions_deleted}`.
  """
  @spec delete_conversation_content(term()) :: {:ok, non_neg_integer()} | {:error, term()}
  def delete_conversation_content(conv_id) do
    with {:ok, n} <- delete_conversation_reactions(conv_id),
         {:ok, _} <- delete_messages(conv_id) do
      {:ok, n}
    else
      {:error, {_step, reason}} -> {:error, reason}
    end
  end

  @doc "Return all `message_id`s in a conversation (partition-local query)."
  @spec collect_message_ids(term()) :: {:ok, [term()]} | {:error, term()}
  def collect_message_ids(conv_id) do
    case Repo.execute_prepared(
           "SELECT message_id FROM messages WHERE conversation_id = ?",
           %{"conversation_id" => {"uuid", to_string(conv_id)}}
         ) do
      {:ok, result} -> {:ok, result |> Enum.map(& &1["message_id"])}
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  # ---- Internal cascade steps ----

  defp cascade_one(acc, conv_id, participant, user_id) do
    with {:ok, n_react} <- delete_conversation_reactions(conv_id),
         {:ok, _} <- delete_messages(conv_id),
         {:ok, _} <- delete_other_side(participant, conv_id) do
      acc
      |> Map.update!(:conversations, &(&1 + 1))
      |> Map.update!(:reactions, &(&1 + n_react))
    else
      {:error, {step, reason}} ->
        Sentry.capture_message("chat conversation cascade failed",
          level: :error,
          extra: %{
            user_id: user_id,
            conversation_id: conv_id,
            step: step,
            reason: inspect(reason)
          }
        )

        add_failure(acc, {step, conv_id, reason})
    end
  end

  defp delete_conversation_reactions(conv_id) do
    case collect_message_ids(conv_id) do
      {:ok, ids} ->
        Enum.reduce_while(ids, {:ok, 0}, fn mid, {:ok, n} ->
          case safe_exec("DELETE FROM reactions WHERE message_id = ?", %{
                 "message_id" => {"timeuuid", to_string(mid)}
               }) do
            :ok -> {:cont, {:ok, n + 1}}
            {:error, reason} -> {:halt, {:error, {:reactions, reason}}}
          end
        end)

      {:error, reason} ->
        {:error, {:reactions, reason}}
    end
  end

  defp delete_messages(conv_id) do
    case safe_exec("DELETE FROM messages WHERE conversation_id = ?", %{
           "conversation_id" => {"uuid", to_string(conv_id)}
         }) do
      :ok -> {:ok, :deleted}
      {:error, reason} -> {:error, {:messages, reason}}
    end
  end

  # Remove the other participant's denormalized copy of this conversation.
  # PK is (user_id, updated_at, conversation_id) so we must find the exact rows.
  defp delete_other_side(nil, _conv_id), do: {:ok, :skipped}

  defp delete_other_side(participant, conv_id) do
    case Repo.execute_prepared(
           "SELECT updated_at, conversation_id FROM conversations WHERE user_id = ?",
           %{"user_id" => {"text", participant}}
         ) do
      {:ok, result} ->
        result
        |> Enum.filter(fn r -> to_string(r["conversation_id"]) == to_string(conv_id) end)
        |> Enum.reduce_while({:ok, :deleted}, fn r, _acc ->
          case delete_conversation_row(participant, r["updated_at"], conv_id) do
            :ok -> {:cont, {:ok, :deleted}}
            {:error, reason} -> {:halt, {:error, {:other_side, reason}}}
          end
        end)

      {:error, reason} ->
        {:error, {:other_side, reason}}
    end
  rescue
    e -> {:error, {:other_side, e}}
  end

  defp delete_owner_partition(user_id) do
    safe_exec("DELETE FROM conversations WHERE user_id = ?", %{"user_id" => {"text", user_id}})
  end

  defp list_user_conversations(user_id) do
    case Repo.execute_prepared(
           "SELECT conversation_id, participant_id FROM conversations WHERE user_id = ?",
           %{"user_id" => {"text", user_id}}
         ) do
      {:ok, result} -> {:ok, Enum.to_list(result)}
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  # ---- Result + telemetry ----

  defp finalize(user_id, %{failures: []} = summary) do
    Audit.log(:account_chat_deleted, summary)
    Posthog.capture("backend_chat_cleanup_completed", user_id, telemetry_props(summary))
    {:ok, summary}
  end

  defp finalize(user_id, %{failures: failures} = summary) do
    reason = {:partial_failures, length(failures)}

    Sentry.capture_message("chat account deletion partial failure",
      level: :error,
      extra: %{user_id: user_id, failures: inspect(failures)}
    )

    Posthog.capture("backend_chat_cleanup_failed", user_id, telemetry_props(summary))
    {:error, reason, summary}
  end

  defp telemetry_props(summary) do
    %{
      conversations: summary.conversations,
      reactions: summary.reactions,
      failure_count: length(summary.failures)
    }
  end

  defp add_failure(summary, failure), do: Map.update!(summary, :failures, &[failure | &1])

  defp safe_exec(query, params) do
    case Repo.execute_prepared(query, params) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end
end

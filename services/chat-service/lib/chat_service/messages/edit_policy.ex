defmodule ChatService.Messages.EditPolicy do
  @moduledoc """
  iMessage edit rules (Oct 2026): a sender can edit a text message within
  15 minutes of sending it, at most 5 times. Every edit keeps the version it
  replaced, so "Edited" can show the previous versions to both sides.

  Pure: no I/O, so the rules are tested without Cassandra.
  """

  @window_seconds 15 * 60
  @max_edits 5
  @history_cap 20

  def window_seconds, do: @window_seconds
  def max_edits, do: @max_edits

  @doc """
  Decides whether `row` (as read from Cassandra) may be edited by `sender_id`
  at `now`. `history` is the decoded list of previous versions.
  """
  def check(row, sender_id, history, now, opts \\ []) do
    # Builds up to 229 have no window, no edit limit and cannot explain a
    # refusal (the edit just reverts). Ownership always applies; the iMessage
    # limits apply only when the client says it knows them (enforce: true).
    enforce = Keyword.get(opts, :enforce, true)
    created_at = row["created_at"]

    cond do
      is_nil(row) -> {:error, :not_found}
      to_string(row["sender_id"]) != to_string(sender_id) -> {:error, :forbidden}
      row["is_deleted"] == true -> {:error, :not_found}
      not enforce -> :ok
      (row["content_type"] || "text") != "text" -> {:error, :not_editable}
      is_nil(created_at) -> {:error, :edit_window_closed}
      DateTime.diff(now, created_at, :second) > @window_seconds -> {:error, :edit_window_closed}
      length(history) >= @max_edits -> {:error, :edit_limit_reached}
      true -> :ok
    end
  end

  @doc """
  The history after replacing the current content: the replaced version is
  appended with the moment it started being the visible one.
  """
  def append(history, previous_content, previous_since) do
    # Old clients can edit without limit: keep the newest versions only.
    (history ++ [%{"content" => previous_content, "since" => format(previous_since)}])
    |> Enum.take(-@history_cap)
  end

  def decode(nil), do: []
  def decode(""), do: []

  def decode(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, list} when is_list(list) -> list
      _ -> []
    end
  end

  defp format(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format(other), do: other
end

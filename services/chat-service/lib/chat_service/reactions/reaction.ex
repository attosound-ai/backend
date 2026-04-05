defmodule ChatService.Reactions.Reaction do
  @moduledoc """
  Struct representing an emoji reaction on a chat message.

  Reactions are partitioned by message_id so all reactions for a message
  can be fetched in a single query.
  """

  @enforce_keys [:message_id, :user_id, :emoji]
  defstruct [
    :message_id,
    :conversation_id,
    :user_id,
    :emoji,
    :created_at
  ]

  @type t :: %__MODULE__{
          message_id: String.t(),
          conversation_id: String.t() | nil,
          user_id: String.t(),
          emoji: String.t(),
          created_at: DateTime.t() | nil
        }

  def from_row(row) when is_map(row) do
    %__MODULE__{
      message_id: to_string(row["message_id"]),
      conversation_id: to_string(row["conversation_id"]),
      user_id: to_string(row["user_id"]),
      emoji: row["emoji"],
      created_at: row["created_at"]
    }
  end

  def to_map(%__MODULE__{} = reaction) do
    %{
      message_id: reaction.message_id,
      conversation_id: reaction.conversation_id,
      user_id: reaction.user_id,
      emoji: reaction.emoji,
      created_at: format_datetime(reaction.created_at)
    }
  end

  defp format_datetime(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_datetime(nil), do: nil
  defp format_datetime(other), do: to_string(other)
end

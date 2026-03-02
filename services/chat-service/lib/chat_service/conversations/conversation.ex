defmodule ChatService.Conversations.Conversation do
  @moduledoc """
  Struct representing a conversation entry from the denormalized conversations table.

  Each user has their own view of a conversation, partitioned by user_id
  and ordered by updated_at DESC for fast listing.
  """

  @enforce_keys [:user_id, :conversation_id, :participant_id]
  defstruct [
    :user_id,
    :conversation_id,
    :participant_id,
    :participant_name,
    :last_message,
    :last_message_at,
    :unread_count,
    :updated_at
  ]

  @type t :: %__MODULE__{
          user_id: String.t(),
          conversation_id: String.t(),
          participant_id: String.t(),
          participant_name: String.t() | nil,
          last_message: String.t() | nil,
          last_message_at: DateTime.t() | nil,
          unread_count: integer(),
          updated_at: DateTime.t() | nil
        }

  @doc """
  Build a Conversation struct from a Cassandra row map.
  """
  def from_row(row) when is_map(row) do
    %__MODULE__{
      user_id: to_string(row["user_id"]),
      conversation_id: to_string(row["conversation_id"]),
      participant_id: to_string(row["participant_id"]),
      participant_name: row["participant_name"],
      last_message: row["last_message"],
      last_message_at: row["last_message_at"],
      unread_count: row["unread_count"] || 0,
      updated_at: row["updated_at"]
    }
  end

  @doc """
  Convert a Conversation struct to a plain map suitable for JSON serialization.
  """
  def to_map(%__MODULE__{} = conv) do
    %{
      conversation_id: conv.conversation_id,
      participant_id: conv.participant_id,
      participant_name: conv.participant_name,
      last_message: conv.last_message,
      last_message_at: format_datetime(conv.last_message_at),
      unread_count: conv.unread_count,
      updated_at: format_datetime(conv.updated_at)
    }
  end

  defp format_datetime(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_datetime(nil), do: nil
  defp format_datetime(other), do: to_string(other)
end

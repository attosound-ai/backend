defmodule ChatService.Messages.Message do
  @moduledoc """
  Struct representing a chat message stored in Cassandra.

  Messages are partitioned by conversation_id and ordered by message_id (timeuuid DESC)
  for efficient reverse-chronological retrieval.
  """

  @enforce_keys [:conversation_id, :message_id, :sender_id, :content, :content_type]
  defstruct [
    :conversation_id,
    :message_id,
    :sender_id,
    :content,
    :content_type,
    :is_read,
    :is_edited,
    :edited_at,
    :is_deleted,
    :deleted_at,
    :deleted_by,
    :reply_to_id,
    :reply_to_content,
    :reply_to_sender,
    :created_at
  ]

  @type t :: %__MODULE__{
          conversation_id: String.t(),
          message_id: String.t(),
          sender_id: String.t(),
          content: String.t(),
          content_type: String.t(),
          is_read: boolean(),
          is_edited: boolean(),
          edited_at: DateTime.t() | nil,
          is_deleted: boolean(),
          deleted_at: DateTime.t() | nil,
          deleted_by: String.t() | nil,
          reply_to_id: String.t() | nil,
          reply_to_content: String.t() | nil,
          reply_to_sender: String.t() | nil,
          created_at: DateTime.t() | nil
        }

  @doc """
  Build a Message struct from a Cassandra row map.
  """
  def from_row(row) when is_map(row) do
    %__MODULE__{
      conversation_id: to_string(row["conversation_id"]),
      message_id: to_string(row["message_id"]),
      sender_id: to_string(row["sender_id"]),
      content: row["content"],
      content_type: row["content_type"] || "text",
      is_read: row["is_read"] || false,
      is_edited: row["is_edited"] || false,
      edited_at: row["edited_at"],
      is_deleted: row["is_deleted"] || false,
      deleted_at: row["deleted_at"],
      deleted_by: row["deleted_by"],
      reply_to_id: row["reply_to_id"],
      reply_to_content: row["reply_to_content"],
      reply_to_sender: row["reply_to_sender"],
      created_at: row["created_at"]
    }
  end

  @doc """
  Convert a Message struct to a plain map suitable for JSON serialization.
  """
  def to_map(%__MODULE__{} = message) do
    %{
      conversation_id: message.conversation_id,
      message_id: message.message_id,
      sender_id: message.sender_id,
      content: message.content,
      content_type: message.content_type,
      is_read: message.is_read,
      is_edited: message.is_edited || false,
      edited_at: format_datetime(message.edited_at),
      is_deleted: message.is_deleted || false,
      deleted_at: format_datetime(message.deleted_at),
      deleted_by: message.deleted_by,
      reply_to_id: message.reply_to_id,
      reply_to_content: message.reply_to_content,
      reply_to_sender: message.reply_to_sender,
      created_at: format_datetime(message.created_at)
    }
  end

  defp format_datetime(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_datetime(nil), do: nil
  defp format_datetime(other), do: to_string(other)
end

defmodule ChatService.Reactions.ReactionService do
  @moduledoc """
  Business logic for message reactions.

  Handles adding, removing, and querying emoji reactions.
  Broadcasts changes via Phoenix PubSub for real-time updates.
  """

  alias ChatService.Reactions.Reaction
  alias ChatService.Repo

  require Logger

  @doc """
  Add an emoji reaction to a message.
  Uses INSERT which is an upsert in Cassandra — safe to call multiple times.
  """
  def add_reaction(message_id, conversation_id, user_id, emoji) do
    now = DateTime.utc_now()

    query = """
    INSERT INTO reactions (message_id, conversation_id, user_id, emoji, created_at)
    VALUES (?, ?, ?, ?, ?)
    """

    params = %{
      "message_id" => {"timeuuid", message_id},
      "conversation_id" => {"uuid", conversation_id},
      "user_id" => {"text", user_id},
      "emoji" => {"text", emoji},
      "created_at" => {"timestamp", now}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, _} ->
        reaction = %Reaction{
          message_id: message_id,
          conversation_id: conversation_id,
          user_id: user_id,
          emoji: emoji,
          created_at: now
        }

        broadcast(conversation_id, "reaction_added", Reaction.to_map(reaction))
        {:ok, reaction}

      {:error, reason} ->
        Logger.error("Failed to add reaction: #{inspect(reason)}")
        {:error, :insert_failed}
    end
  end

  @doc """
  Remove a user's reaction from a message.
  """
  def remove_reaction(message_id, conversation_id, user_id, emoji) do
    query = """
    DELETE FROM reactions
    WHERE message_id = ? AND user_id = ?
    """

    params = %{
      "message_id" => {"timeuuid", message_id},
      "user_id" => {"text", user_id}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, _} ->
        broadcast(conversation_id, "reaction_removed", %{
          message_id: message_id,
          user_id: user_id,
          emoji: emoji
        })

        :ok

      {:error, reason} ->
        Logger.error("Failed to remove reaction: #{inspect(reason)}")
        {:error, :delete_failed}
    end
  end

  @doc """
  Get all reactions for a single message.
  """
  def get_reactions(message_id) do
    query = """
    SELECT message_id, conversation_id, user_id, emoji, created_at
    FROM reactions
    WHERE message_id = ?
    """

    params = %{"message_id" => {"timeuuid", message_id}}

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        reactions =
          result
          |> Enum.to_list()
          |> Enum.map(&Reaction.from_row/1)

        {:ok, reactions}

      {:error, reason} ->
        Logger.error("Failed to get reactions: #{inspect(reason)}")
        {:error, :query_failed}
    end
  end

  @doc """
  Get reactions for a batch of message IDs.
  Returns a map of message_id => [Reaction].
  """
  def get_reactions_batch(message_ids) when is_list(message_ids) do
    if message_ids == [] do
      {:ok, %{}}
    else
      results =
        message_ids
        |> Task.async_stream(
          fn mid -> {mid, get_reactions(mid)} end,
          max_concurrency: 10,
          timeout: 5_000
        )
        |> Enum.reduce(%{}, fn
          {:ok, {mid, {:ok, reactions}}}, acc -> Map.put(acc, mid, reactions)
          {:ok, {mid, {:error, _}}}, acc -> Map.put(acc, mid, [])
          {:exit, _}, acc -> acc
        end)

      {:ok, results}
    end
  end

  defp broadcast(conversation_id, event, payload) do
    Phoenix.PubSub.broadcast(
      ChatService.PubSub,
      "chat:#{conversation_id}",
      {String.to_atom(event), payload}
    )
  end
end

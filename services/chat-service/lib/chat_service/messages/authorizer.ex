defmodule ChatService.Messages.Authorizer do
  @moduledoc """
  Authorization contract for message mutations.

  A behaviour deliberately isolated from persistence and transport so each
  concern can evolve independently (SOLID: Single Responsibility + Dependency
  Inversion). The concrete implementation is resolved at runtime via
  `Application.get_env/3`, which lets tests swap in stubs without touching
  `MessageService`.

  The default implementation (`ChatService.Messages.Authorizer.Default`) only
  authorizes the original sender. Future authorizers (moderator overrides,
  time-based revocation windows, retention policies) can be added as new
  modules implementing this behaviour, without modifying existing call sites —
  Open/Closed Principle.
  """

  @typedoc "Result of an authorization check."
  @type result :: :ok | {:error, :not_found | :forbidden | :query_failed}

  @callback can_delete?(
              message_id :: String.t(),
              conversation_id :: String.t(),
              user_id :: String.t()
            ) :: result()

  @doc """
  Delegates to the configured implementation.
  """
  @spec can_delete?(String.t(), String.t(), String.t()) :: result()
  def can_delete?(message_id, conversation_id, user_id) do
    impl().can_delete?(message_id, conversation_id, user_id)
  end

  defp impl do
    Application.get_env(
      :chat_service,
      :message_authorizer,
      ChatService.Messages.Authorizer.Default
    )
  end
end

defmodule ChatService.Messages.Authorizer.Default do
  @moduledoc """
  Default `ChatService.Messages.Authorizer` implementation.

  Authorizes a delete iff the requesting `user_id` equals the original
  `sender_id` stored in Cassandra. All other outcomes — row missing, sender
  mismatch, or query failure — map to a specific error atom so callers can
  discriminate without inspecting driver internals.
  """

  @behaviour ChatService.Messages.Authorizer

  alias ChatService.Repo
  require Logger

  @impl true
  def can_delete?(message_id, conversation_id, user_id) do
    query = """
    SELECT sender_id FROM messages
    WHERE conversation_id = ? AND message_id = ?
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, result} ->
        row = result |> Enum.to_list() |> List.first()

        cond do
          is_nil(row) -> {:error, :not_found}
          to_string(row["sender_id"]) != user_id -> {:error, :forbidden}
          true -> :ok
        end

      {:error, reason} ->
        Logger.error("Authorizer query failed: #{inspect(reason)}")
        {:error, :query_failed}
    end
  end
end

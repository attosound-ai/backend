defmodule ChatService.Messages.ClientKeyStore do
  @moduledoc """
  Where client keys are claimed (see `ChatService.Messages.ClientKey`).

  The concrete implementation is resolved at runtime via `Application.get_env/3`
  (`:message_client_key_store`), like `ChatService.Messages.Persistence`, so the
  dedupe rules can be tested without Cassandra.
  """

  alias ChatService.Messages.Message

  @callback claim(
              conversation_id :: String.t(),
              sender_id :: String.t(),
              key :: String.t(),
              message_id :: String.t()
            ) :: :claimed | {:taken, String.t()} | {:error, term()}

  @callback release(conversation_id :: String.t(), sender_id :: String.t(), key :: String.t()) ::
              :ok

  @callback fetch_message(conversation_id :: String.t(), message_id :: String.t()) ::
              {:ok, Message.t()} | {:error, :not_found | term()}

  def impl do
    Application.get_env(
      :chat_service,
      :message_client_key_store,
      ChatService.Messages.ClientKeyStore.Cassandra
    )
  end

  @doc """
  The table, also created at boot by `ChatService.Application`. Thirty days
  are far more than any retry needs (the app gives up after one day, a
  manual "Send again" can come later), and the TTL keeps the table small.
  Additive: nothing else reads or changes it.
  """
  def table_ddl(keyspace \\ nil) do
    name = if keyspace, do: "#{keyspace}.message_client_keys", else: "message_client_keys"

    """
    CREATE TABLE IF NOT EXISTS #{name} (
      conversation_id uuid,
      sender_id text,
      client_key text,
      message_id timeuuid,
      PRIMARY KEY ((conversation_id, sender_id), client_key)
    ) WITH default_time_to_live = 2592000
    """
  end
end

defmodule ChatService.Messages.ClientKeyStore.Cassandra do
  @moduledoc """
  Cassandra implementation: one lightweight transaction per keyed send.

  If the table is missing (the boot DDL is known to fail silently when
  Xandra returns before its socket is up), the first claim creates it and
  tries once more; any other error lets the send go through undeduped.
  """

  @behaviour ChatService.Messages.ClientKeyStore

  alias ChatService.Messages.ClientKeyStore
  alias ChatService.Messages.Message
  alias ChatService.Repo
  require Logger

  @claim """
  INSERT INTO message_client_keys (conversation_id, sender_id, client_key, message_id)
  VALUES (?, ?, ?, ?) IF NOT EXISTS
  """

  @impl true
  def claim(conversation_id, sender_id, key, message_id) do
    case do_claim(conversation_id, sender_id, key, message_id) do
      {:error, reason} = error ->
        if missing_table?(reason) and ensure_table() == :ok do
          do_claim(conversation_id, sender_id, key, message_id)
        else
          error
        end

      result ->
        result
    end
  end

  defp do_claim(conversation_id, sender_id, key, message_id) do
    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "sender_id" => {"text", sender_id},
      "client_key" => {"text", key},
      "message_id" => {"timeuuid", message_id}
    }

    case Repo.execute_prepared(@claim, params) do
      {:ok, page} -> claim_outcome(page |> Enum.to_list() |> List.first())
      {:error, reason} -> {:error, reason}
    end
  rescue
    error -> {:error, error}
  catch
    :exit, reason -> {:error, {:exit, reason}}
  end

  @doc false
  # The row a conditional insert answers with: `[applied]` true, or false with
  # the row that was already there.
  def claim_outcome(%{"[applied]" => true}), do: :claimed

  def claim_outcome(%{"[applied]" => false} = row) do
    case row["message_id"] do
      nil -> {:error, :claim_without_message_id}
      id -> {:taken, to_string(id)}
    end
  end

  def claim_outcome(other), do: {:error, {:unexpected_claim_answer, other}}

  @impl true
  def release(conversation_id, sender_id, key) do
    query = """
    DELETE FROM message_client_keys
    WHERE conversation_id = ? AND sender_id = ? AND client_key = ?
    """

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "sender_id" => {"text", sender_id},
      "client_key" => {"text", key}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, _} -> :ok
      {:error, reason} -> Logger.warning("[CLIENT_KEY] release failed: #{inspect(reason)}")
    end

    :ok
  rescue
    _ -> :ok
  end

  @impl true
  def fetch_message(conversation_id, message_id) do
    query = "SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?"

    params = %{
      "conversation_id" => {"uuid", conversation_id},
      "message_id" => {"timeuuid", message_id}
    }

    case Repo.execute_prepared(query, params) do
      {:ok, page} ->
        case page |> Enum.to_list() |> List.first() do
          nil -> {:error, :not_found}
          row -> {:ok, Message.from_row(row)}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc false
  def missing_table?(reason) do
    text = inspect(reason)

    String.contains?(text, "unconfigured table") or
      (String.contains?(text, "message_client_keys") and String.contains?(text, "does not exist"))
  end

  defp ensure_table do
    case Repo.execute_simple(ClientKeyStore.table_ddl()) do
      {:ok, _} ->
        Logger.info("[CLIENT_KEY] created table message_client_keys")
        :ok

      {:error, reason} ->
        Logger.error("[CLIENT_KEY] could not create message_client_keys: #{inspect(reason)}")
        :error
    end
  rescue
    _ -> :error
  end
end

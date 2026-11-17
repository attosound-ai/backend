defmodule ChatService.Accounts.Deactivated do
  @moduledoc """
  Accounts in their 30 day deletion grace (user-service, Nov 12 2026).

  While an account waits for its final deletion nobody else may see it in
  chat: its conversations leave everyone's list, its messages are not
  served, and nobody can write to it. When it recovers everything comes
  back untouched (nothing is deleted here; `user.deleted` does that later).

  The set lives in a public ETS table on every node. It is fed by the
  `user.deactivated` / `user.reactivated` Kafka events; only one node of the
  consumer group receives each event, so the change is re-broadcast on
  Phoenix PubSub to every node. On boot the table is seeded from the
  user-service Postgres when `:user_service_db_url` is configured (the same
  read only DSN `mix chat.cleanup_orphans` uses); without it, it starts
  empty and fills from the events.
  """

  use GenServer
  require Logger

  @table :chat_deactivated_users
  @topic "accounts:deactivated"

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Is this account in its deletion grace? False when the table is not up."
  @spec deactivated?(String.t() | integer() | nil) :: boolean()
  def deactivated?(nil), do: false

  def deactivated?(user_id) do
    :ets.member(@table, to_string(user_id))
  rescue
    ArgumentError -> false
  end

  @doc "True when at least one account is in grace (skips lookups otherwise)."
  @spec any?() :: boolean()
  def any? do
    :ets.info(@table, :size) not in [0, :undefined]
  rescue
    ArgumentError -> false
  end

  @doc "Drops the conversations whose other participant is in deletion grace."
  @spec reject_hidden_participants([map()], (String.t() -> boolean())) :: [map()]
  def reject_hidden_participants(conversations, hidden? \\ &deactivated?/1) do
    Enum.reject(conversations, fn c ->
      hidden?.(to_string(Map.get(c, :participant_id) || Map.get(c, "participant_id") || ""))
    end)
  end

  @doc "Marks accounts as deactivated on every node."
  def add(user_ids), do: broadcast({:deactivated, normalize(user_ids)})

  @doc "Marks accounts as active again on every node."
  def remove(user_ids), do: broadcast({:reactivated, normalize(user_ids)})

  defp broadcast(msg) do
    # Apply locally first so the caller sees it at once, then tell the rest.
    apply_change(msg)
    Phoenix.PubSub.broadcast_from(ChatService.PubSub, self(), @topic, msg)
    :ok
  end

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    Phoenix.PubSub.subscribe(ChatService.PubSub, @topic)
    send(self(), :seed)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:seed, state) do
    seed_from_user_service()
    {:noreply, state}
  end

  def handle_info({kind, _ids} = msg, state) when kind in [:deactivated, :reactivated] do
    apply_change(msg)
    {:noreply, state}
  end

  def handle_info(_other, state), do: {:noreply, state}

  defp apply_change({:deactivated, ids}) do
    if table?(), do: Enum.each(ids, &:ets.insert(@table, {&1, true}))
  end

  defp apply_change({:reactivated, ids}) do
    if table?(), do: Enum.each(ids, &:ets.delete(@table, &1))
  end

  defp table?, do: :ets.whereis(@table) != :undefined

  defp normalize(ids) do
    ids
    |> List.wrap()
    |> Enum.map(&to_string/1)
    |> Enum.reject(&(&1 == ""))
  end

  # Best effort: a missing DSN, an old user-service without the column, or a
  # network error only means the table starts empty.
  defp seed_from_user_service do
    case Application.get_env(:chat_service, :user_service_db_url) do
      url when is_binary(url) and url != "" ->
        try do
          ids = ChatService.Cleanup.LiveUserSet.load_deactivated!(url)
          apply_change({:deactivated, ids})
          Logger.info("Deactivated accounts seeded: #{length(ids)}")
        rescue
          e -> Logger.warning("Could not seed deactivated accounts: #{Exception.message(e)}")
        end

      _ ->
        :ok
    end
  end
end

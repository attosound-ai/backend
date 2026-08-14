defmodule ChatService.Cleanup.LiveUserSet do
  @moduledoc """
  Loads the set of currently-existing user ids from the user-service Postgres.

  Used by `mix chat.cleanup_orphans` as the source of truth: any chat row whose
  owner or participant id is NOT in this set belongs to a hard-deleted account.

  Opens a short-lived read-only connection driven by `USER_SERVICE_DB_URL`
  (config key `:user_service_db_url`). A one-shot `SELECT id FROM users` is far
  cheaper than per-id HTTP/gRPC existence checks for a full-table scan.
  """

  require Logger

  @spec load!() :: MapSet.t()
  def load! do
    url =
      Application.get_env(:chat_service, :user_service_db_url) ||
        raise """
        USER_SERVICE_DB_URL is not configured.
        Set it (read-only DSN to the user-service Postgres) before running
        `mix chat.cleanup_orphans`, e.g.
          USER_SERVICE_DB_URL=postgresql://atto:atto_dev@localhost:5440/atto_users
        """

    {:ok, conn} = Postgrex.start_link(connection_opts(url))

    try do
      %Postgrex.Result{rows: rows} =
        Postgrex.query!(conn, "SELECT id::text FROM users", [], timeout: 60_000)

      rows |> Enum.map(fn [id] -> id end) |> MapSet.new()
    after
      GenServer.stop(conn)
    end
  end

  defp connection_opts(url) do
    uri = URI.parse(url)

    {user, pass} =
      case uri.userinfo do
        nil -> {nil, nil}
        ui -> case String.split(ui, ":", parts: 2) do
                [u, p] -> {u, p}
                [u] -> {u, nil}
              end
      end

    [
      hostname: uri.host || "localhost",
      port: uri.port || 5432,
      username: user,
      password: pass,
      database: String.trim_leading(uri.path || "", "/"),
      ssl: ssl_opts(url),
      pool_size: 1
    ]
  end

  # Railway/managed Postgres require TLS; local docker-compose does not.
  defp ssl_opts(url) do
    if String.contains?(url, "sslmode=require") or String.contains?(url, "sslmode=prefer") do
      [verify: :verify_none]
    else
      false
    end
  end
end

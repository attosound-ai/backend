defmodule ChatServiceWeb.Plugs.RequireUserId do
  @moduledoc """
  Plug that extracts and validates the X-User-ID header.

  Assigns `user_id` to `conn.assigns` on success.
  Returns 401 JSON error on missing/empty header.
  """
  import Plug.Conn
  import Phoenix.Controller, only: [json: 2]

  def init(opts), do: opts

  def call(conn, _opts) do
    case get_req_header(conn, "x-user-id") do
      [user_id] when user_id != "" ->
        assign(conn, :user_id, user_id)

      _ ->
        conn
        |> put_status(401)
        |> json(%{success: false, data: nil, error: "Missing X-User-ID header"})
        |> halt()
    end
  end
end

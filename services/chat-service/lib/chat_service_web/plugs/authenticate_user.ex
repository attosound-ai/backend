defmodule ChatServiceWeb.Plugs.AuthenticateUser do
  @moduledoc """
  Authenticates HTTP requests against an HS256 Bearer JWT issued by
  the user-service. Assigns `:user_id` to `conn.assigns` on success.

  On failure, responds 401 with an RFC 6750 compliant
  `WWW-Authenticate: Bearer error="invalid_token"` header so clients
  can distinguish unauthenticated vs. forbidden responses.

  This plug replaces the legacy `RequireUserId` plug, which trusted the
  `X-User-ID` header — a header that is no longer forwarded through Kong.
  """

  import Plug.Conn

  alias ChatService.Auth.JWT

  require Logger

  def init(opts), do: opts

  def call(conn, _opts) do
    with {:ok, token} <- extract_bearer(conn),
         {:ok, user_id} <- JWT.verify_user_token(token) do
      assign(conn, :user_id, user_id)
    else
      {:error, reason} -> reject(conn, reason)
    end
  end

  defp extract_bearer(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] when token != "" -> {:ok, token}
      _ -> {:error, :missing_token}
    end
  end

  defp reject(conn, reason) do
    Logger.info("auth rejected: #{reason}")

    conn
    |> put_resp_header("www-authenticate", ~s(Bearer error="invalid_token"))
    |> put_resp_content_type("application/json")
    |> send_resp(
      401,
      Jason.encode!(%{success: false, data: nil, error: "Unauthorized"})
    )
    |> halt()
  end
end

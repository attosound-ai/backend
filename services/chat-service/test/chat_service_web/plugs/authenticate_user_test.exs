defmodule ChatServiceWeb.Plugs.AuthenticateUserTest do
  use ExUnit.Case, async: true
  use Plug.Test

  alias ChatServiceWeb.Plugs.AuthenticateUser

  @secret Application.compile_env!(:chat_service, ChatService.Auth.JWT)[:secret]
  @issuer "atto-sound-user-service"

  defp valid_token(sub) do
    signer = Joken.Signer.create("HS256", @secret)
    claims = %{"sub" => sub, "iss" => @issuer, "exp" => System.system_time(:second) + 3600}
    {:ok, jwt, _} = Joken.encode_and_sign(claims, signer)
    jwt
  end

  test "assigns :user_id when a valid Bearer JWT is present" do
    jwt = valid_token("166")

    conn =
      conn(:get, "/api/v1/messages/conversations")
      |> put_req_header("authorization", "Bearer " <> jwt)
      |> AuthenticateUser.call([])

    refute conn.halted
    assert conn.assigns.user_id == "166"
  end

  test "rejects requests without an Authorization header" do
    conn =
      conn(:get, "/api/v1/messages/conversations")
      |> AuthenticateUser.call([])

    assert conn.halted
    assert conn.status == 401
    assert get_resp_header(conn, "www-authenticate") == [~s(Bearer error="invalid_token")]
  end

  test "rejects requests with a malformed Authorization header" do
    conn =
      conn(:get, "/api/v1/messages/conversations")
      |> put_req_header("authorization", "Token abc123")
      |> AuthenticateUser.call([])

    assert conn.halted
    assert conn.status == 401
  end

  test "rejects requests with an invalid token" do
    conn =
      conn(:get, "/api/v1/messages/conversations")
      |> put_req_header("authorization", "Bearer not.a.real.token")
      |> AuthenticateUser.call([])

    assert conn.halted
    assert conn.status == 401
  end
end

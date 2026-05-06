defmodule ChatServiceWeb.UserSocketTest do
  use ExUnit.Case, async: true

  alias ChatServiceWeb.UserSocket

  @secret Application.compile_env!(:chat_service, ChatService.Auth.JWT)[:secret]
  @issuer "atto-sound-user-service"

  defp valid_token(sub) do
    signer = Joken.Signer.create("HS256", @secret)
    claims = %{"sub" => sub, "iss" => @issuer, "exp" => System.system_time(:second) + 3600}
    {:ok, jwt, _} = Joken.encode_and_sign(claims, signer)
    jwt
  end

  defp empty_socket do
    %Phoenix.Socket{
      assigns: %{},
      endpoint: ChatServiceWeb.Endpoint,
      handler: UserSocket,
      id: nil,
      transport: :websocket
    }
  end

  test "accepts a valid JWT and assigns user_id" do
    jwt = valid_token("166")
    assert {:ok, socket} = UserSocket.connect(%{"token" => jwt}, empty_socket(), %{})
    assert socket.assigns.user_id == "166"
  end

  test "rejects an expired token" do
    signer = Joken.Signer.create("HS256", @secret)
    claims = %{"sub" => "166", "iss" => @issuer, "exp" => System.system_time(:second) - 10}
    {:ok, expired, _} = Joken.encode_and_sign(claims, signer)

    assert :error = UserSocket.connect(%{"token" => expired}, empty_socket(), %{})
  end

  test "rejects a token signed with the wrong secret" do
    bad_signer = Joken.Signer.create("HS256", "different-secret")
    claims = %{"sub" => "166", "iss" => @issuer, "exp" => System.system_time(:second) + 3600}
    {:ok, bad, _} = Joken.encode_and_sign(claims, bad_signer)

    assert :error = UserSocket.connect(%{"token" => bad}, empty_socket(), %{})
  end

  test "rejects a connection with no token param" do
    assert :error = UserSocket.connect(%{}, empty_socket(), %{})
  end

  test "rejects a connection with an empty token" do
    assert :error = UserSocket.connect(%{"token" => ""}, empty_socket(), %{})
  end

  test "rejects a raw user_id passed as token (no longer accepted)" do
    # The previous implementation had a dangerous fallback that accepted
    # any UUID or numeric string as a valid token. This regression test
    # ensures it stays gone.
    assert :error = UserSocket.connect(%{"token" => "166"}, empty_socket(), %{})

    assert :error =
             UserSocket.connect(
               %{"token" => "12345678-1234-1234-1234-123456789abc"},
               empty_socket(),
               %{}
             )
  end
end
